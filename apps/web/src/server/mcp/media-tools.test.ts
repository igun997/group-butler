import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { COLLECTIONS } from "../collections";
import { closeDb, getDb } from "../mongo";
import type { AuditEntry } from "../repos/audit";
import {
  IMAGE_MAX_SOURCE_BYTES,
  MEDIA_TOOL_LIMITS,
  connectMediaTools,
  consumableMime,
  createMediaMcpServer,
  parseCsv,
  runMediaTool,
  type MediaObjectReader,
  type MediaToolInput,
  type MediaToolName,
  type ToolChatContext,
} from "./media-tools";

const OWNER = "628990000001@s.whatsapp.net";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** The binary spreadsheet format a workbook used to be: declared, and still refused. */
const XLS_MIME = "application/vnd.ms-excel";

/**
 * Whether a local extraction binary exists at all. `spawnSync` reports a missing
 * executable through `error`, so a binary that runs and exits non-zero (as
 * `ffmpeg -v` does) still counts as present. Tests that need the binary run
 * only when it is here; the unavailable path is asserted separately and never
 * skipped, so a missing tool cannot hide behind a skip.
 */
const hasBinary = (command: string) => spawnSync(command, ["-v"], { stdio: "ignore" }).error === undefined;

/** One verified reply job in a group: the chat itself is the group, so its tools take no scope at all. */
const contextA: ToolChatContext = {
  organizationId: "org-a",
  instanceId: "instance-a",
  chatKind: "group",
  chatJid: "group-a@g.us",
  groupJid: "group-a@g.us",
  authorizedJids: [OWNER],
};
const contextB: ToolChatContext = {
  organizationId: "org-b",
  instanceId: "instance-b",
  chatKind: "group",
  chatJid: "group-b@g.us",
  groupJid: "group-b@g.us",
  authorizedJids: [OWNER],
};

/** The same tenant and instance, read as the owner's own chat: no group in the job at all. */
const dmContext: ToolChatContext = {
  organizationId: "org-a",
  instanceId: "instance-a",
  chatKind: "user",
  chatJid: OWNER,
  groupJid: null,
  authorizedJids: [OWNER],
};

const keyA = (name: string) => `org/org-a/instance/instance-a/group/group-a/2026/09/${name}`;
const CSV_KEY_A = keyA("rows.csv");
const IMAGE_KEY_A = keyA("img.png");
const IMAGE_KEY_B = "org/org-b/instance/instance-b/group/group-b/2026/09/img.png";

const pngA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x01]);
const pngB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x02]);
/** Big enough that its base64 form cannot fit the result cap. */
const bigPng = Buffer.alloc(MEDIA_TOOL_LIMITS.resultChars, 0x1a);

/** A one-page PDF whose content stream holds one line of text. */
function samplePdf(): Buffer {
  const stream = "BT /F1 24 Tf 72 700 Td (Hello PDF 42) Tj ET";
  return Buffer.from(
    [
      "%PDF-1.4",
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj",
      `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`,
      "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj",
      "trailer\n<< /Root 1 0 R /Size 6 >>",
      "%%EOF",
    ].join("\n"),
    "utf8",
  );
}

/**
 * A ZIP of stored (uncompressed) members, which is all an OOXML package is: the
 * fixture needs no compressor, and every member carries a real CRC32 and a real
 * offset so `unzip` accepts the archive.
 */
function zipOf(members: readonly (readonly [string, Buffer])[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of members) {
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.byteLength, 18);
    local.writeUInt32LE(content.byteLength, 22);
    local.writeUInt16LE(nameBytes.byteLength, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(content.byteLength, 20);
    entry.writeUInt32LE(content.byteLength, 24);
    entry.writeUInt16LE(nameBytes.byteLength, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, content);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.byteLength + content.byteLength;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

const docxBytes = zipOf([
  [
    "word/document.xml",
    Buffer.from(
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Quarterly report &amp; totals</w:t></w:r></w:p><w:p><w:r><w:t>Revenue 1200</w:t></w:r></w:p></w:body></w:document>',
      "utf8",
    ),
  ],
]);

/** A shared-string table in the shape a workbook writes one. */
const sharedStringsXml = (items: readonly string[]): string =>
  `<?xml version="1.0"?><sst xmlns="x">${items.map((item) => `<si><t>${item}</t></si>`).join("")}</sst>`;

/** One worksheet holding the rows given, as a workbook writes them. */
const sheetXml = (rows: string): Buffer =>
  Buffer.from(`<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`, "utf8");

/**
 * The two members that name a workbook's worksheets: the manifest lists two
 * sheets and its relationships map the first one's id to `target`, so a reader
 * has to follow the manifest rather than assume a file name.
 */
function workbookParts(target: string): (readonly [string, Buffer])[] {
  return [
    [
      "xl/workbook.xml",
      Buffer.from(
        '<?xml version="1.0"?><workbook xmlns:r="x"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Later" sheetId="2" r:id="rId2"/></sheets></workbook>',
      ),
    ],
    [
      "xl/_rels/workbook.xml.rels",
      Buffer.from(
        `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="x/worksheet" Target="${target}"/><Relationship Id="rId2" Type="x/worksheet" Target="worksheets/other.xml"/></Relationships>`,
      ),
    ],
  ];
}

/** A workbook whose header is shared strings, whose second row adds a formula and a number. */
const xlsxBytes = zipOf([
  ...workbookParts("worksheets/sheet1.xml"),
  ["xl/sharedStrings.xml", Buffer.from(sharedStringsXml(["name", "total", "bolt & nut"]))],
  [
    "xl/worksheets/sheet1.xml",
    sheetXml(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c><c r="C2"><f>B2*2</f><v>24</v></c></row>',
    ),
  ],
]);

/** The same package with `sheet2.xml` named first and `sheet1.xml` left in as a decoy. */
const xlsxReorderedBytes = zipOf([
  ...workbookParts("worksheets/sheet2.xml"),
  ["xl/sharedStrings.xml", Buffer.from(sharedStringsXml(["second tab", "decoy"]))],
  ["xl/worksheets/sheet1.xml", sheetXml('<row r="1"><c r="A1" t="s"><v>1</v></c></row>')],
  ["xl/worksheets/sheet2.xml", sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>')],
]);

/**
 * A workbook as Excel itself writes one: no shared-string table at all, cells
 * carrying their text inline, and a relationship whose target is absolute
 * (`/xl/worksheets/sheet1.xml`). This is the shape of the real file that arrived
 * unreadable — `mapping-uac19…xlsx` — and of the second thing that made it so:
 * the capture records such a file as `application/zip`, because that is what its
 * bytes are.
 */
const excelStyleBytes = zipOf([
  [
    "xl/workbook.xml",
    Buffer.from(
      '<?xml version="1.0"?><workbook xmlns:r="x"><sheets><sheet name="Mapping UAC19" sheetId="1" state="visible" r:id="rId1"/></sheets></workbook>',
    ),
  ],
  [
    "xl/_rels/workbook.xml.rels",
    Buffer.from(
      '<?xml version="1.0"?><Relationships><Relationship Type="x/worksheet" Target="/xl/worksheets/sheet1.xml" Id="rId1"/></Relationships>',
    ),
  ],
  [
    "xl/worksheets/sheet1.xml",
    sheetXml(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>terminal_id</t></is></c><c r="B1" t="inlineStr"><is><t>display_name</t></is></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>uac19-smagpm</t></is></c><c r="B2" t="inlineStr"><is><t>Abdul Hafizh I</t></is></c></row>',
    ),
  ],
]);

/** A zip that is neither a workbook nor a document: accepting the container must not read this. */
const plainZipBytes = zipOf([["photos/holiday.txt", Buffer.from("not a document at all")]]);

/** A workbook whose cells all reference a shared-string table with no entries. */
const xlsxEmptyBytes = zipOf([
  ...workbookParts("worksheets/sheet1.xml"),
  ["xl/sharedStrings.xml", Buffer.from('<?xml version="1.0"?><sst xmlns="x" count="1" uniqueCount="0"></sst>')],
  ["xl/worksheets/sheet1.xml", sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>')],
]);

/** A workbook whose cell text carries a zero-width space and a bidi override. */
const xlsxControlBytes = zipOf([
  ...workbookParts("worksheets/sheet1.xml"),
  ["xl/sharedStrings.xml", Buffer.from(sharedStringsXml(["data&#8203;set", "safe\u202etext"]))],
  ["xl/worksheets/sheet1.xml", sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>')],
]);

/** A package with no shared-string member at all, as a workbook of numbers writes one. */
const xlsxNumbersBytes = zipOf([
  ...workbookParts("worksheets/sheet1.xml"),
  ["xl/worksheets/sheet1.xml", sheetXml('<row r="1"><c r="A1"><v>7</v></c><c r="B1"><v>8.5</v></c></row>')],
]);

/** A package whose manifest names its first sheet as a path outside the worksheet parts. */
const xlsxTraversalBytes = zipOf([
  ...workbookParts("../../../../etc/passwd"),
  ["xl/sharedStrings.xml", Buffer.from(sharedStringsXml(["secret"]))],
  ["xl/worksheets/sheet1.xml", sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>')],
]);

const objects = new Map<string, Uint8Array>([
  [IMAGE_KEY_A, pngA],
  [IMAGE_KEY_B, pngB],
  [
    CSV_KEY_A,
    Buffer.from('name,qty,note\n"bolt, m8",2,"he said ""hi"""\r\nnut,3,plain\nwasher,9,plain\nextra,10,plain\n'),
  ],
  [keyA("big.png"), bigPng],
  [keyA("notes.txt"), Buffer.from("release notes\nsecond line")],
  [keyA("data.json"), Buffer.from('{"ok":true}')],
  [keyA("broken.json"), Buffer.from("{not json")],
  [keyA("report.pdf"), samplePdf()],
  [keyA("stale.pdf"), Buffer.from("%PDF-1.4")],
  [keyA("board.docx"), docxBytes],
  [keyA("budget.xlsx"), xlsxBytes],
  [keyA("excel-style.xlsx"), excelStyleBytes],
  [keyA("archive.zip"), plainZipBytes],
  [keyA("reordered.xlsx"), xlsxReorderedBytes],
  [keyA("empty.xlsx"), xlsxEmptyBytes],
  [keyA("controls.xlsx"), xlsxControlBytes],
  [keyA("numbers.xlsx"), xlsxNumbersBytes],
  [keyA("traversal.xlsx"), xlsxTraversalBytes],
  [keyA("old.xls"), Buffer.from("PK\u0003\u0004not really a workbook")],
  [keyA("scan.tif"), Buffer.from([0x49, 0x49, 0x2a, 0x00])],
  [keyA("voice.ogg"), Buffer.from([0x4f, 0x67, 0x67, 0x53])],
  // A placeholder MP4 box; the real sampler test overwrites it with a clip the
  // local ffmpeg actually produced.
  [keyA("clip.mp4"), Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])],
  [keyA("long.txt"), Buffer.from("x".repeat(5_000))],
  [keyA("secret.pdf"), Buffer.from("never read")],
]);

/** One worker-written row: identity, kind, and the flattened `media.*` subdocument. */
function message(
  organizationId: string,
  instanceId: string,
  groupJid: string,
  waMessageId: string,
  kind: string,
  media: Record<string, unknown>,
) {
  return {
    organizationId,
    instanceId,
    groupJid,
    waMessageId,
    senderJid: OWNER,
    kind,
    text: "",
    timestamp: new Date("2026-09-13T10:00:00Z"),
    media,
  };
}

let mongo: MongoMemoryServer;
let db: Db;
let reader: Mock<MediaObjectReader>;
let audit: Mock<(db: Db, entry: AuditEntry) => Promise<void>>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = "butler_media_tools_test";
});

beforeEach(async () => {
  await closeDb();
  db = await getDb();
  reader = vi.fn<MediaObjectReader>(async (key) => objects.get(key) ?? null);
  audit = vi.fn<(db: Db, entry: AuditEntry) => Promise<void>>(async () => {});
  await Promise.all(
    [COLLECTIONS.groups, COLLECTIONS.messages].map((name) => db.collection(name).deleteMany({})),
  );
  await db.collection(COLLECTIONS.groups).insertMany([
    { organizationId: "org-a", instanceId: "instance-a", groupJid: "group-a@g.us", config: { assigned: true, whitelisted: true } },
    { organizationId: "org-b", instanceId: "instance-b", groupJid: "group-b@g.us", config: { assigned: true, whitelisted: true } },
    { organizationId: "org-a", instanceId: "instance-a", groupJid: "group-c@g.us", config: { assigned: true, whitelisted: false } },
    { organizationId: "org-a", instanceId: "instance-a", groupJid: "group-d@g.us", config: { assigned: false, whitelisted: true } },
  ]);
  await db.collection(COLLECTIONS.messages).insertMany([
    message("org-a", "instance-a", "group-a@g.us", "img", "image", { status: "stored", mime: "image/png", r2Key: IMAGE_KEY_A }),
    message("org-b", "instance-b", "group-b@g.us", "img", "image", { status: "stored", mime: "image/png", r2Key: IMAGE_KEY_B }),
    message("org-a", "instance-a", "group-a@g.us", "bigimg", "image", { status: "stored", mime: "image/png", r2Key: keyA("big.png") }),
    message("org-a", "instance-a", "group-a@g.us", "csv", "document", { status: "stored", mime: "text/csv", r2Key: CSV_KEY_A }),
    message("org-a", "instance-a", "group-a@g.us", "notes", "document", { status: "stored", mime: "text/plain", r2Key: keyA("notes.txt") }),
    message("org-a", "instance-a", "group-a@g.us", "json", "document", { status: "stored", mime: "application/json", r2Key: keyA("data.json") }),
    message("org-a", "instance-a", "group-a@g.us", "broken", "document", { status: "stored", mime: "application/json", r2Key: keyA("broken.json") }),
    message("org-a", "instance-a", "group-a@g.us", "pdf", "document", { status: "stored", mime: "application/pdf", r2Key: keyA("report.pdf") }),
    message("org-a", "instance-a", "group-a@g.us", "stale", "document", { status: "stored", mime: "application/pdf", r2Key: keyA("stale.pdf") }),
    message("org-a", "instance-a", "group-a@g.us", "docx", "document", { status: "stored", mime: DOCX_MIME, r2Key: keyA("board.docx") }),
    message("org-a", "instance-a", "group-a@g.us", "sheet", "document", { status: "stored", mime: XLSX_MIME, r2Key: keyA("budget.xlsx") }),
    // What the capture really records for an Excel file: the container's MIME.
    message("org-a", "instance-a", "group-a@g.us", "container", "document", { status: "stored", mime: "application/zip", r2Key: keyA("excel-style.xlsx") }),
    message("org-a", "instance-a", "group-a@g.us", "zipdoc", "document", { status: "stored", mime: "application/zip", r2Key: keyA("archive.zip") }),
    message("org-a", "instance-a", "group-a@g.us", "reordered", "document", { status: "stored", mime: XLSX_MIME, r2Key: keyA("reordered.xlsx") }),
    message("org-a", "instance-a", "group-a@g.us", "empty", "document", { status: "stored", mime: XLSX_MIME, r2Key: keyA("empty.xlsx") }),
    message("org-a", "instance-a", "group-a@g.us", "controls", "document", { status: "stored", mime: XLSX_MIME, r2Key: keyA("controls.xlsx") }),
    message("org-a", "instance-a", "group-a@g.us", "numbers", "document", { status: "stored", mime: XLSX_MIME, r2Key: keyA("numbers.xlsx") }),
    message("org-a", "instance-a", "group-a@g.us", "traversal", "document", { status: "stored", mime: XLSX_MIME, r2Key: keyA("traversal.xlsx") }),
    message("org-a", "instance-a", "group-a@g.us", "huge", "document", { status: "stored", mime: XLSX_MIME, r2Key: keyA("huge.xlsx") }),
    message("org-a", "instance-a", "group-a@g.us", "legacy", "document", { status: "stored", mime: XLS_MIME, r2Key: keyA("old.xls") }),
    message("org-a", "instance-a", "group-a@g.us", "tiff", "image", { status: "stored", mime: "image/tiff", r2Key: keyA("scan.tif") }),
    message("org-a", "instance-a", "group-a@g.us", "voice", "audio", { status: "stored", mime: "audio/ogg", r2Key: keyA("voice.ogg") }),
    message("org-a", "instance-a", "group-a@g.us", "clip", "video", { status: "stored", mime: "video/mp4", r2Key: keyA("clip.mp4") }),
    // The resizing tests replace these objects with images the local binary made.
    message("org-a", "instance-a", "group-a@g.us", "photo", "image", { status: "stored", mime: "image/png", r2Key: keyA("photo.png") }),
    message("org-a", "instance-a", "group-a@g.us", "noise", "image", { status: "stored", mime: "image/png", r2Key: keyA("noise.png") }),
    message("org-a", "instance-a", "group-a@g.us", "pending", "image", { status: "pending", mime: "image/png", r2Key: null }),
    message("org-a", "instance-a", "group-a@g.us", "long", "document", { status: "stored", mime: "text/plain", r2Key: keyA("long.txt") }),
    message("org-a", "instance-a", "group-c@g.us", "img", "image", { status: "stored", mime: "image/png", r2Key: IMAGE_KEY_A }),
    message("org-a", "instance-a", "group-d@g.us", "img", "image", { status: "stored", mime: "image/png", r2Key: IMAGE_KEY_A }),
    message("org-a", "instance-a", "group-a@g.us", "unstored", "document", { status: "unparsed", mime: "application/pdf", r2Key: keyA("secret.pdf") }),
    // The direct-chat reads: the owner's own chat, and one row per group the
    // instance does and does not monitor.
    message("org-a", "instance-a", OWNER, "dmimg", "image", { status: "stored", mime: "image/png", r2Key: IMAGE_KEY_A }),
    message("org-a", "instance-a", "group-c@g.us", "cimg", "image", { status: "stored", mime: "image/png", r2Key: IMAGE_KEY_A }),
    message("org-a", "instance-a", "group-d@g.us", "dimg", "image", { status: "stored", mime: "image/png", r2Key: IMAGE_KEY_A }),
    message("org-b", "instance-b", "group-b@g.us", "otherTenant", "image", { status: "stored", mime: "image/png", r2Key: IMAGE_KEY_B }),
  ]);
});

afterAll(async () => {
  await closeDb();
  await mongo.stop();
});

const call = (name: MediaToolName, input: MediaToolInput, context: ToolChatContext = contextA) =>
  runMediaTool(context, { db, readObject: reader, audit }, name, input);

describe("media tool scope", () => {
  /**
   * The regression this change exists for: a group job's read needs the message
   * id and nothing else. The job already knows its own tenant, instance and
   * group, so there is no scope for the model to restate — and the ids it may
   * have seen in its prompt are dropped rather than compared.
   */
  test("reads in a group job from the message id alone, ignoring a smuggled scope", async () => {
    const read = await call("media_get_image", { waMessageId: "img" });
    const smuggled = await call("media_read_csv", {
      waMessageId: "csv",
      instanceId: "instance-b",
      groupJid: "group-b@g.us",
    } as MediaToolInput);

    expect(read).toMatchObject({ ok: true, messageId: "img", mime: "image/png" });
    expect(smuggled).toMatchObject({ ok: true, messageId: "csv", columns: ["name", "qty", "note"] });
    expect(reader).toHaveBeenCalledWith(IMAGE_KEY_A, "org-a", IMAGE_MAX_SOURCE_BYTES);
  });

  test("refuses a group that is not whitelisted, or whitelisted but not assigned", async () => {
    const unlisted = await call("media_get_image", { waMessageId: "img" }, { ...contextA, groupJid: "group-c@g.us" });
    const unassigned = await call("media_get_image", { waMessageId: "img" }, { ...contextA, groupJid: "group-d@g.us" });

    expect(unlisted).toEqual({ ok: false, code: "not_available" });
    expect(unassigned).toEqual({ ok: false, code: "not_available" });
    expect(reader).not.toHaveBeenCalled();
  });

  test("reads nothing at all when the context carries no authorized owner", async () => {
    const group = await call("media_get_image", { waMessageId: "img" }, { ...contextA, authorizedJids: [] });
    const direct = await call("media_get_image", { waMessageId: "img" }, { ...dmContext, authorizedJids: [] });

    expect(group).toEqual({ ok: false, code: "not_available" });
    expect(direct).toEqual({ ok: false, code: "not_available" });
    expect(reader).not.toHaveBeenCalled();
  });

  test("reads nothing from a descriptor whose chat kind and group do not go together", async () => {
    const groupWithoutGroup = await call("media_get_image", { waMessageId: "img" }, { ...contextA, groupJid: null });
    const directWithGroup = await call("media_get_image", { waMessageId: "img" }, { ...dmContext, groupJid: "group-a@g.us" });

    expect(groupWithoutGroup).toEqual({ ok: false, code: "not_available" });
    expect(directWithGroup).toEqual({ ok: false, code: "not_available" });
    expect(reader).not.toHaveBeenCalled();
  });

  test("a direct chat reads its own attachments and any monitored group's", async () => {
    const own = await call("media_get_image", { waMessageId: "dmimg" }, dmContext);
    const monitored = await call("media_read_csv", { waMessageId: "csv" }, dmContext);

    expect(own).toMatchObject({ ok: true, messageId: "dmimg", mime: "image/png" });
    expect(monitored).toMatchObject({ ok: true, messageId: "csv", columns: ["name", "qty", "note"] });
  });

  test("a direct chat reads nothing from a group the instance does not monitor", async () => {
    const unlisted = await call("media_get_image", { waMessageId: "cimg" }, dmContext);
    const unassigned = await call("media_get_image", { waMessageId: "dimg" }, dmContext);
    const elsewhere = await call("media_get_image", { waMessageId: "otherTenant" }, dmContext);

    expect(unlisted).toEqual({ ok: false, code: "not_available" });
    expect(unassigned).toEqual({ ok: false, code: "not_available" });
    expect(elsewhere).toEqual({ ok: false, code: "not_available" });
    expect(reader).not.toHaveBeenCalled();
  });

  test("never crosses tenants, even when both tenants use the same message id", async () => {
    const mine = await call("media_get_image", { waMessageId: "img" }, contextA);
    const theirs = await call("media_get_image", { waMessageId: "img" }, contextB);

    expect(mine).toMatchObject({ ok: true, sha256: expect.any(String) });
    expect(theirs).toMatchObject({ ok: true, sha256: expect.any(String) });
    if (!mine.ok || !theirs.ok || !("sha256" in mine) || !("sha256" in theirs)) throw new Error("expected image results");
    expect(mine.sha256).not.toBe(theirs.sha256);
    expect(reader).toHaveBeenCalledWith(IMAGE_KEY_A, "org-a", IMAGE_MAX_SOURCE_BYTES);
    expect(reader).toHaveBeenCalledWith(IMAGE_KEY_B, "org-b", IMAGE_MAX_SOURCE_BYTES);
  });

  test("answers one indistinguishable refusal for absence, lifecycle, tenant, and MIME", async () => {
    const results = [
      await call("media_get_image", { waMessageId: "missing" }),
      await call("media_get_image", { waMessageId: "pending" }),
      await call("media_get_image", { waMessageId: "unstored" }),
      await call("media_get_image", { waMessageId: "tiff" }),
      await call("media_read_csv", { waMessageId: "pdf" }),
      await call("media_get_image", { waMessageId: "img" }, { ...contextA, instanceId: "instance-b" }),
      await call("media_get_image", { waMessageId: "img" }, { ...contextA, groupJid: "group-c@g.us" }),
      await call("media_get_image", { waMessageId: "cimg" }, dmContext),
      await call("media_get_image", { waMessageId: "img" }, { ...contextA, chatJid: "" }),
      await call("media_get_image", { waMessageId: "img" }, { ...contextA, authorizedJids: [""] }),
    ];

    expect(new Set(results.map((result) => JSON.stringify(result)))).toEqual(new Set([JSON.stringify({ ok: false, code: "not_available" })]));
  });

  test("never reads an unstored attachment, not even to inspect it", async () => {
    const result = await call("media_read_document", { waMessageId: "unstored" });

    expect(result).toEqual({ ok: false, code: "not_available" });
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("media tool failures stay uniform", () => {
  test("turns a scope-query failure into the unavailable result and retains its audit metadata", async () => {
    const brokenDb = {
      collection: vi.fn(() => ({
        findOne: vi.fn(async () => {
          throw new Error("MongoDB query failed");
        }),
      })),
    } as unknown as Db;

    await expect(
      runMediaTool(
        contextA,
        { db: brokenDb, readObject: reader, audit },
        "media_get_image",
        { waMessageId: "img" },
      ),
    ).resolves.toEqual({ ok: false, code: "not_available" });
    expect(audit).toHaveBeenCalledWith(
      brokenDb,
      expect.objectContaining({ meta: expect.objectContaining({ code: "not_available", operation: "media_get_image" }) }),
    );
  });
  test("turns database acquisition failures into the unavailable result without auditing", async () => {
    const getDatabase = vi.fn(async (): Promise<Db> => {
      throw new Error("MongoDB is unavailable");
    });

    await expect(
      runMediaTool(
        contextA,
        { getDatabase, readObject: reader, audit },
        "media_get_image",
        { waMessageId: "img" },
      ),
    ).resolves.toEqual({ ok: false, code: "not_available" });
    expect(audit).not.toHaveBeenCalled();
  });
  test("turns a reader that throws into the same unavailable result", async () => {
    reader.mockRejectedValueOnce(new Error("R2 said no"));

    expect(await call("media_get_image", { waMessageId: "img" })).toEqual({ ok: false, code: "not_available" });
    expect(audit.mock.calls.at(-1)?.[1].meta).toMatchObject({ code: "not_available", operation: "media_get_image" });
  });

  test("turns an extractor that throws into the same unavailable result", async () => {
    reader.mockRejectedValueOnce(new RangeError("out of memory"));

    expect(await call("media_read_document", { waMessageId: "notes" })).toEqual({ ok: false, code: "not_available" });
  });

  test("never logs or audits what was read when a read fails", async () => {
    reader.mockRejectedValueOnce(new Error("boom: bolt, m8"));

    await call("media_read_csv", { waMessageId: "csv" });
    expect(JSON.stringify(audit.mock.calls.map(([, entry]) => entry))).not.toContain("bolt, m8");
  });
});

describe("media tool reads", () => {
  test("returns a stored image as a data URL with its digest", async () => {
    const result = await call("media_get_image", { waMessageId: "img" });

    if (!result.ok || !("dataUrl" in result)) throw new Error("expected an image result");
    expect(result.messageId).toBe("img");
    expect(result.mime).toBe("image/png");
    expect(result.dataUrl).toBe(`data:image/png;base64,${pngA.toString("base64")}`);
    expect(reader).toHaveBeenCalledWith(IMAGE_KEY_A, "org-a", IMAGE_MAX_SOURCE_BYTES);
  });

  test("reads at most the plan's 8 MiB image source cap", () => {
    expect(IMAGE_MAX_SOURCE_BYTES).toBe(MEDIA_TOOL_LIMITS.imageBytes);
    expect(IMAGE_MAX_SOURCE_BYTES).toBe(8 * 1024 * 1024);
  });

  test("refuses an image that cannot be resized and does not already fit", async () => {
    // The bytes are not an image any local binary can read, so no resize can
    // shrink them and the untouched copy is far past the result cap.
    const result = await call("media_get_image", { waMessageId: "bigimg" });

    expect(result).toEqual({ ok: false, code: "not_available" });
  });

  test("reads a stored CSV through the row's own key, with its header and rows", async () => {
    const result = await call("media_read_csv", { waMessageId: "csv" });

    if (!result.ok || !("columns" in result)) throw new Error("expected a CSV result");
    expect(result.columns).toEqual(["name", "qty", "note"]);
    expect(result.rows[0]).toEqual(["bolt, m8", "2", 'he said "hi"']);
    expect(result.rows).toHaveLength(4);
    expect(result.truncated).toBe(false);
    expect(reader).toHaveBeenCalledWith(CSV_KEY_A, "org-a", MEDIA_TOOL_LIMITS.csvBytes);
  });

  test("applies the row and column caps and says the table was truncated", async () => {
    const result = await call("media_read_csv", { waMessageId: "csv", maxRows: 2, maxColumns: 2 });

    if (!result.ok || !("columns" in result)) throw new Error("expected a CSV result");
    expect(result.columns).toEqual(["name", "qty"]);
    expect(result.rows).toEqual([
      ["bolt, m8", "2"],
      ["nut", "3"],
    ]);
    expect(result.truncated).toBe(true);
  });

  test("extracts stored TXT and UTF-8 JSON, and caps the text", async () => {
    const notes = await call("media_read_document", { waMessageId: "notes" });
    const json = await call("media_read_document", { waMessageId: "json" });
    const capped = await call("media_read_document", { waMessageId: "long", maxChars: 10 });

    if (!notes.ok || !("text" in notes) || !json.ok || !("text" in json) || !capped.ok || !("text" in capped)) {
      throw new Error("expected document results");
    }
    expect(notes.text).toBe("release notes\nsecond line");
    expect(notes.truncated).toBe(false);
    expect(JSON.parse(json.text)).toEqual({ ok: true });
    expect(capped.text).toBe("x".repeat(10));
    expect(capped.truncated).toBe(true);
    expect(reader).toHaveBeenCalledWith(keyA("notes.txt"), "org-a", MEDIA_TOOL_LIMITS.documentBytes);
  });

  test("refuses JSON that does not parse rather than returning a mangled document", async () => {
    expect(await call("media_read_document", { waMessageId: "broken" })).toEqual({ ok: false, code: "not_available" });
  });

  test("answers unavailable for a PDF whose bytes yield no text", async () => {
    expect(await call("media_read_document", { waMessageId: "stale" })).toEqual({ ok: false, code: "not_available" });
  });

  test("answers unavailable for audio and video without touching the object", async () => {
    const audio = await call("media_transcribe_audio", { waMessageId: "voice" });
    const video = await call("media_describe_video", { waMessageId: "voice" });

    expect(audio).toEqual({ ok: false, code: "not_available" });
    expect(video).toEqual({ ok: false, code: "not_available" });
    expect(reader).not.toHaveBeenCalled();
  });

  test("maps a failed object read to the same unavailable result", async () => {
    reader.mockResolvedValueOnce(null);

    expect(await call("media_get_image", { waMessageId: "img" })).toEqual({ ok: false, code: "not_available" });
  });

  test("clamps an out-of-range cap instead of trusting the caller", async () => {
    const result = await call("media_read_csv", { waMessageId: "csv", maxRows: 9_999, maxColumns: 0 });

    if (!result.ok || !("columns" in result)) throw new Error("expected a CSV result");
    expect(result.columns).toHaveLength(1);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

/**
 * The plan's capability matrix, as the deployment actually implements it. These
 * are the assertions that keep a gap a known gap: what each tool consumes, what
 * it refuses, and what is declared but not yet processing anything.
 */
describe("media capability matrix", () => {
  test("names the stored MIME each tool may consume, and nothing else", () => {
    expect(consumableMime("media_get_image", "image/png")).toBe(true);
    expect(consumableMime("media_get_image", "IMAGE/PNG")).toBe(true);
    expect(consumableMime("media_get_image", "image/tiff")).toBe(false);

    expect(consumableMime("media_read_csv", "text/csv")).toBe(true);
    expect(consumableMime("media_read_csv", "application/pdf")).toBe(false);

    expect(consumableMime("media_read_document", "text/plain")).toBe(true);
    expect(consumableMime("media_read_document", "application/pdf")).toBe(true);
    expect(consumableMime("media_read_document", DOCX_MIME)).toBe(true);
    expect(consumableMime("media_read_document", XLSX_MIME)).toBe(true);
    expect(consumableMime("media_read_document", XLS_MIME)).toBe(false);

    expect(consumableMime("media_transcribe_audio", "audio/ogg")).toBe(true);
    expect(consumableMime("media_transcribe_audio", "video/mp4")).toBe(false);
    expect(consumableMime("media_describe_video", "video/mp4")).toBe(true);
    expect(consumableMime("media_describe_video", "video/x-matroska")).toBe(false);
  });

  test("keeps audio scoped, capped and never operational without a local transcriber", async () => {
    // No local speech-to-text binary ships with this deployment, so the tool
    // checks scope, status and MIME, clamps its cap, and then answers the same
    // code an unsupported attachment gets. It is registered for a schema that
    // cannot widen access, never as a capability that produces a transcript.
    const wrongMime = await call("media_transcribe_audio", { waMessageId: "img" });
    const capped = await call("media_transcribe_audio", { waMessageId: "voice", maxSeconds: 99_999 });
    const scoped = await call("media_transcribe_audio", { waMessageId: "voice" });

    expect(wrongMime).toEqual({ ok: false, code: "not_available" });
    expect(capped).toEqual({ ok: false, code: "not_available" });
    expect(scoped).toEqual({ ok: false, code: "not_available" });
    expect(reader).not.toHaveBeenCalled();
  });

  test("refuses a video MIME for an audio-only message, and vice versa, before reading", async () => {
    expect(await call("media_describe_video", { waMessageId: "voice" })).toEqual({ ok: false, code: "not_available" });
    expect(await call("media_transcribe_audio", { waMessageId: "clip" })).toEqual({ ok: false, code: "not_available" });
    expect(reader).not.toHaveBeenCalled();
  });

  test("the binary spreadsheet format a workbook used to be stays unsupported, refused before any read", async () => {
    expect(await call("media_read_document", { waMessageId: "legacy" })).toEqual({ ok: false, code: "not_available" });
    expect(reader).not.toHaveBeenCalled();
  });
});

describe("document extraction with local tools", () => {
  test.skipIf(!hasBinary("pdftotext"))("extracts PDF text through the local pdftotext", async () => {
    const result = await call("media_read_document", { waMessageId: "pdf" });

    if (!result.ok || !("text" in result)) throw new Error("expected a document result");
    expect(result.mime).toBe("application/pdf");
    expect(result.text.trim()).toBe("Hello PDF 42");
    expect(reader).toHaveBeenCalledWith(keyA("report.pdf"), "org-a", MEDIA_TOOL_LIMITS.documentBytes);
  });

  test.skipIf(!hasBinary("unzip"))("extracts DOCX text from word/document.xml only", async () => {
    const result = await call("media_read_document", { waMessageId: "docx" });

    if (!result.ok || !("text" in result)) throw new Error("expected a document result");
    expect(result.mime).toBe(DOCX_MIME);
    expect(result.text).toBe("Quarterly report & totals\nRevenue 1200\n");
  });

  test.skipIf(!hasBinary("unzip"))("extracts worksheet rows as tab-separated lines, resolving shared strings", async () => {
    const result = await call("media_read_document", { waMessageId: "sheet" });

    if (!result.ok || !("text" in result)) throw new Error("expected a document result");
    expect(result.mime).toBe(XLSX_MIME);
    // One line per stored row, one tab per cell, shared strings resolved, and the
    // formula cell's cached value rather than the formula itself.
    expect(result.text).toBe("name\ttotal\tbolt & nut\nbolt & nut\t12\t24\n");
    expect(reader).toHaveBeenCalledWith(keyA("budget.xlsx"), "org-a", MEDIA_TOOL_LIMITS.documentBytes);
  });

  /**
   * The reported failure: an ordinary Excel 2007 workbook answered `not_available`
   * because the capture had recorded it as `application/zip` — which is what an
   * xlsx is — and the tool matched MIMEs rather than reading the package.
   */
  test.skipIf(!hasBinary("unzip"))("reads a workbook the capture stored as a zip container", async () => {
    const result = await call("media_read_document", { waMessageId: "container" });

    if (!result.ok || !("text" in result)) throw new Error("expected a document result");
    expect(result.mime).toBe("application/zip");
    // Inline strings, no shared-string table, and an absolute relationship target:
    // the shape Excel writes and the shape that failed.
    expect(result.text).toBe("terminal_id\tdisplay_name\nuac19-smagpm\tAbdul Hafizh I\n");
  });

  // The container is accepted, not the archive: a zip holding anything else is
  // still the uniform refusal, so this widened nothing a caller can reach.
  test.skipIf(!hasBinary("unzip"))("refuses a zip that is neither a workbook nor a document", async () => {
    expect(await call("media_read_document", { waMessageId: "zipdoc" })).toMatchObject({ ok: false, code: "not_available" });
  });

  test.skipIf(!hasBinary("unzip"))("reads the worksheet the manifest names first, not the first file in the package", async () => {
    const result = await call("media_read_document", { waMessageId: "reordered" });

    if (!result.ok || !("text" in result)) throw new Error("expected a document result");
    expect(result.text).toBe("second tab\n");
  });

  test.skipIf(!hasBinary("unzip"))("answers unavailable when every cell resolves to no text", async () => {
    // The workbook is read and its worksheet parsed; what makes it unavailable is
    // that the shared-string table it points at is empty, not a refused MIME.
    expect(await call("media_read_document", { waMessageId: "empty" })).toEqual({ ok: false, code: "not_available" });
    expect(reader).toHaveBeenCalledWith(keyA("empty.xlsx"), "org-a", MEDIA_TOOL_LIMITS.documentBytes);
  });

  test.skipIf(!hasBinary("unzip"))("strips control and format characters out of cell text", async () => {
    const result = await call("media_read_document", { waMessageId: "controls" });

    if (!result.ok || !("text" in result)) throw new Error("expected a document result");
    expect(result.text).toBe("dataset\tsafetext\n");
  });

  test.skipIf(!hasBinary("unzip"))("reads a workbook that carries no shared-string table at all", async () => {
    const result = await call("media_read_document", { waMessageId: "numbers" });

    if (!result.ok || !("text" in result)) throw new Error("expected a document result");
    expect(result.text).toBe("7\t8.5\n");
  });

  test.skipIf(!hasBinary("unzip"))("refuses a manifest that names anything but a worksheet part", async () => {
    // A crafted package cannot point the reader at a member outside the
    // worksheet parts, and its own decoy worksheet is never read instead.
    expect(await call("media_read_document", { waMessageId: "traversal" })).toEqual({ ok: false, code: "not_available" });
    expect(reader).toHaveBeenCalledWith(keyA("traversal.xlsx"), "org-a", MEDIA_TOOL_LIMITS.documentBytes);
  });

  test("refuses an oversized workbook at the source cap instead of reading it in", async () => {
    const oversized = Buffer.alloc(MEDIA_TOOL_LIMITS.documentBytes + 1, 0x50);
    objects.set(keyA("huge.xlsx"), oversized);
    // The production reader refuses an object past the cap it is handed; what is
    // asserted here is that the tool hands it the document cap and reads once.
    const capped = vi.fn<MediaObjectReader>(async (key, _organizationId, maxBytes) => {
      const value = objects.get(key) ?? null;
      return value !== null && value.byteLength > maxBytes ? null : value;
    });

    const result = await runMediaTool(contextA, { db, readObject: capped, audit }, "media_read_document", {
      waMessageId: "huge",
    });

    expect(oversized.byteLength).toBeGreaterThan(MEDIA_TOOL_LIMITS.documentBytes);
    expect(capped).toHaveBeenCalledExactlyOnceWith(keyA("huge.xlsx"), "org-a", MEDIA_TOOL_LIMITS.documentBytes);
    expect(result).toEqual({ ok: false, code: "not_available" });
  });

  test("answers unavailable rather than claiming a capability when the extractor is absent", async () => {
    vi.stubEnv("PATH", "/nonexistent-butler-tools");
    try {
      expect(await call("media_read_document", { waMessageId: "pdf" })).toEqual({ ok: false, code: "not_available" });
      expect(await call("media_read_document", { waMessageId: "docx" })).toEqual({ ok: false, code: "not_available" });
      expect(await call("media_read_document", { waMessageId: "sheet" })).toEqual({ ok: false, code: "not_available" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

/** One locally produced image, decoded back so its real dimensions can be read. */
function identify(image: Buffer): string {
  return spawnSync("identify", ["-format", "%wx%h", "-"], { input: image, encoding: "utf8" }).stdout;
}

/** What a stored image result actually handed back, decoded from its data URL. */
function decodeDataUrl(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

describe("image resizing with local tools", () => {
  const magick = hasBinary("magick") ? "magick" : "convert";

  test.skipIf(!hasBinary("convert"))("resizes a 2,000px image to the plan's 1,536px ceiling, inside the cap", async () => {
    const source = spawnSync(magick, ["-size", "2000x1400", "gradient:blue-red", "png:-"], { maxBuffer: 64 * 1024 * 1024 }).stdout;
    objects.set(keyA("photo.png"), source);

    const result = await call("media_get_image", { waMessageId: "photo" });

    if (!result.ok || !("dataUrl" in result)) throw new Error("expected an image result");
    expect(reader).toHaveBeenCalledWith(keyA("photo.png"), "org-a", IMAGE_MAX_SOURCE_BYTES);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MEDIA_TOOL_LIMITS.resultChars);
    // The stored format survives when the resized copy already fits...
    expect(result.mime).toBe("image/png");
    expect(identify(decodeDataUrl(result.dataUrl))).toBe("1536x1075");
  });

  test.skipIf(!hasBinary("convert"))("re-encodes a resize that would overshoot the cap as a bounded JPEG", async () => {
    // Noise does not compress, so the 1,536px PNG copy cannot fit one result.
    const source = spawnSync(magick, ["-size", "2000x1400", "xc:", "+noise", "Random", "png:-"], { maxBuffer: 64 * 1024 * 1024 }).stdout;
    objects.set(keyA("noise.png"), source);

    const result = await call("media_get_image", { waMessageId: "noise" });

    if (!result.ok || !("dataUrl" in result)) throw new Error("expected an image result");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MEDIA_TOOL_LIMITS.resultChars);
    expect(result.mime).toBe("image/jpeg");
    const returned = decodeDataUrl(result.dataUrl);
    expect(returned.byteLength).toBeLessThan(source.byteLength);
    expect(Math.max(...identify(returned).split("x").map(Number))).toBe(1536);
  });

  test("answers unavailable rather than claiming a resize when no image binary can run", async () => {
    vi.stubEnv("PATH", "/nonexistent-butler-tools");
    try {
      // Invalid bytes and no binary: nothing can shrink them, so the untouched
      // copy is refused by the result cap exactly as before.
      expect(await call("media_get_image", { waMessageId: "bigimg" })).toEqual({ ok: false, code: "not_available" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("video frame sampling with local tools", () => {
  /** A real two-second clip the local ffmpeg produced, written through a temp file. */
  function sampleClip(): Buffer {
    const directory = mkdtempSync(join(tmpdir(), "butler-test-clip-"));
    try {
      const path = join(directory, "clip.mp4");
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2", "-pix_fmt", "yuv420p", path]);
      return readFileSync(path);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test.skipIf(!hasBinary("ffmpeg") || !hasBinary("ffprobe"))("samples frames through the local ffmpeg inside the result cap", async () => {
    objects.set(keyA("clip.mp4"), sampleClip());

    const result = await call("media_describe_video", { waMessageId: "clip", maxFrames: 4 });

    if (!result.ok || !("frames" in result)) throw new Error("expected a video result");
    expect(reader).toHaveBeenCalledWith(keyA("clip.mp4"), "org-a", MEDIA_TOOL_LIMITS.videoBytes);
    expect(result.durationSec).toBeCloseTo(2, 1);
    expect(result.frames.length).toBeGreaterThanOrEqual(1);
    expect(result.frames.length).toBeLessThanOrEqual(4);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MEDIA_TOOL_LIMITS.resultChars);
    for (const frame of result.frames) {
      expect(frame.atSec).toBeGreaterThanOrEqual(0);
      expect(frame.imageDataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
      const decoded = decodeDataUrl(frame.imageDataUrl);
      expect(decoded.byteLength).toBeGreaterThan(0);
      expect(Math.max(...identify(decoded).split("x").map(Number))).toBeLessThanOrEqual(MEDIA_TOOL_LIMITS.videoFrameEdgePx);
    }
    // Sampling is spread across the clip, so the positions strictly increase.
    expect([...result.frames].map((frame) => frame.atSec)).toEqual([...result.frames].map((frame) => frame.atSec).sort((a, b) => a - b));
  });

  test("answers unavailable rather than claiming a sampler when no video binary can run", async () => {
    vi.stubEnv("PATH", "/nonexistent-butler-tools");
    try {
      expect(await call("media_describe_video", { waMessageId: "clip" })).toEqual({ ok: false, code: "not_available" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("media tool audit", () => {
  test("records identities, operation, result code, bytes and duration only", async () => {
    await call("media_read_csv", { waMessageId: "csv" });
    await call("media_get_image", { waMessageId: "missing" });

    const [read, refused] = audit.mock.calls.map(([, entry]) => entry);
    expect(read).toMatchObject({
      organizationId: "org-a",
      action: "media.tool.read",
      target: { type: "message", id: "csv" },
      meta: { instanceId: "instance-a", groupJid: "group-a@g.us", operation: "media_read_csv", code: "ok" },
    });
    expect(read?.meta?.bytes).toBeGreaterThan(0);
    expect(typeof read?.meta?.durationMs).toBe("number");
    expect(refused?.meta).toMatchObject({ operation: "media_get_image", code: "not_available", bytes: expect.any(Number) });
    // The row is evidence of the read, never a copy of it.
    const entries = JSON.stringify(audit.mock.calls.map(([, entry]) => entry));
    expect(entries).not.toContain("bolt, m8");
    expect(entries).not.toContain(pngA.toString("base64"));
  });

  test("names the group a direct chat's read turned out to be about", async () => {
    audit.mockClear();
    await call("media_read_csv", { waMessageId: "csv" }, dmContext);
    await call("media_get_image", { waMessageId: "cimg" }, dmContext);

    const [monitored, refused] = audit.mock.calls.map(([, entry]) => entry);
    expect(monitored?.meta).toMatchObject({ groupJid: "group-a@g.us", operation: "media_read_csv", code: "ok" });
    // A refused direct-chat read names no group: the job never had one.
    expect(refused?.meta).toMatchObject({ groupJid: null, operation: "media_get_image", code: "not_available" });
  });
});

describe("parseCsv", () => {
  test("reads quoted fields, escaped quotes, CRLF and a BOM; formulas stay text", () => {
    const table = parseCsv('\uFEFFa,b\r\n"x,y","say ""hi"""\r\n=1+1,@cmd\r\n', 10, 10);

    expect(table.columns).toEqual(["a", "b"]);
    expect(table.rows).toEqual([
      ["x,y", 'say "hi"'],
      ["=1+1", "@cmd"],
    ]);
    expect(table.truncated).toBe(false);
  });

  test("flags a row overflow, a column overflow, and a clipped cell", () => {
    const rows = parseCsv("h\n1\n2\n3\n", 2, 5);
    const columns = parseCsv("h1,h2,h3\n1,2,3\n", 5, 2);
    const cell = parseCsv(`h\n${"z".repeat(MEDIA_TOOL_LIMITS.cellScalars + 1)}\n`, 5, 5);

    expect(rows.rows).toEqual([["1"], ["2"]]);
    expect(rows.truncated).toBe(true);
    expect(columns.columns).toEqual(["h1", "h2"]);
    expect(columns.rows).toEqual([["1", "2"]]);
    expect(columns.truncated).toBe(true);
    expect(cell.rows[0]?.[0]).toHaveLength(MEDIA_TOOL_LIMITS.cellScalars);
    expect(cell.truncated).toBe(true);
  });

  test("reads an empty export as an empty table", () => {
    expect(parseCsv("", 5, 5)).toEqual({ columns: [], rows: [], truncated: false });
  });
});

describe("media MCP server", () => {
  async function connect() {
    const server = createMediaMcpServer(contextA, { db, readObject: reader, audit });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "media-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
  }

  function textOf(result: unknown): Record<string, unknown> {
    const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
    const block = content[0];
    if (block?.type !== "text" || block.text === undefined) throw new Error("expected a text result");
    return JSON.parse(block.text) as Record<string, unknown>;
  }

  test("registers the five media tools over a real MCP session", async () => {
    const { client, server } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "media_describe_video",
        "media_get_image",
        "media_read_csv",
        "media_read_document",
        "media_transcribe_audio",
      ]);
      const result = await client.callTool({ name: "media_read_csv", arguments: { waMessageId: "csv" } });
      expect(textOf(result)).toMatchObject({ ok: true, messageId: "csv", columns: ["name", "qty", "note"] });
      // The model is offered the message and that tool's own caps, and no scope
      // at all: the job's chat is the scope, so there is nothing to restate.
      const csv = tools.find((tool) => tool.name === "media_read_csv");
      const schema = JSON.parse(JSON.stringify(csv?.inputSchema)) as { properties?: Record<string, unknown> };
      expect(Object.keys(schema.properties ?? {})).toEqual(["waMessageId", "maxRows", "maxColumns"]);
      // Every one of them requires the message id, and none may ever be callable
      // with no arguments: this deployment's gateway drops a tool call that
      // carries no input, so such a tool would fail with nothing behind it.
      for (const tool of tools) {
        const shape = JSON.parse(JSON.stringify(tool.inputSchema)) as { required?: string[] };
        expect(shape.required ?? [], tool.name).not.toEqual([]);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("ignores an R2 key, a URL, or a path smuggled into a tool call", async () => {
    const { client, server } = await connect();
    try {
      const result = await client.callTool({
        name: "media_get_image",
        arguments: { waMessageId: "img", r2Key: IMAGE_KEY_B, url: "https://example.com/x.png", path: "/etc/passwd" },
      });

      expect(textOf(result)).toMatchObject({ ok: true, messageId: "img" });
      expect(reader).toHaveBeenCalledWith(IMAGE_KEY_A, "org-a", IMAGE_MAX_SOURCE_BYTES);
      expect(reader).not.toHaveBeenCalledWith(IMAGE_KEY_B, expect.anything(), expect.anything());
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects a cap above the registered maximum before the handler runs", async () => {
    const { client, server } = await connect();
    try {
      const rejected = async (arguments_: Record<string, unknown>) =>
        client.callTool({ name: "media_read_csv", arguments: arguments_ }).then(
          (result) => result.isError === true,
          () => true,
        );

      expect(await rejected({ waMessageId: "csv", maxRows: MEDIA_TOOL_LIMITS.csvRows + 1 })).toBe(true);
      expect(await rejected({ waMessageId: "csv", maxColumns: 0 })).toBe(true);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("caps the audio and video tools' own bounds in their registered schemas", async () => {
    const { client, server } = await connect();
    try {
      const rejected = async (name: string, arguments_: Record<string, unknown>) =>
        client.callTool({ name, arguments: arguments_ }).then(
          (result) => result.isError === true,
          () => true,
        );

      expect(await rejected("media_transcribe_audio", { waMessageId: "voice", maxSeconds: MEDIA_TOOL_LIMITS.audioSeconds + 1 })).toBe(true);
      expect(await rejected("media_describe_video", { waMessageId: "voice", maxFrames: MEDIA_TOOL_LIMITS.videoFrames + 1 })).toBe(true);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("media MCP session cleanup", () => {
  test("closes both ends of the transport pair when one side fails to handshake", async () => {
    const original = InMemoryTransport.createLinkedPair;
    const createPair = vi.spyOn(InMemoryTransport, "createLinkedPair");
    const pair: InMemoryTransport[] = [];
    createPair.mockImplementationOnce(() => {
      const linked = original();
      pair.push(...linked);
      // Half a handshake: the server attaches, the client's transport refuses.
      linked[0].start = async () => {
        throw new Error("client transport refused to start");
      };
      return linked;
    });
    try {
      await expect(connectMediaTools(contextA, { db, readObject: reader, audit })).rejects.toThrow(
        "client transport refused to start",
      );
      const serverTransport = pair[1];
      if (serverTransport === undefined) throw new Error("expected a linked transport pair");
      // The endpoint the server did attach to was closed with the other one, so
      // no half-open transport outlives the failed connect.
      await expect(serverTransport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow("Not connected");
    } finally {
      createPair.mockRestore();
    }
  });
});
