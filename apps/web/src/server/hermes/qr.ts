import { deflateSync } from "node:zlib";

/**
 * The QR the WhatsApp bridge prints, turned back into an image.
 *
 * Hermes's bridge renders its pairing QR with `qrcode-terminal`'s "small" mode,
 * which packs two module rows into each line of text using half-block glyphs. It
 * is a lossless encoding of the module matrix, so the image the console shows can
 * be rebuilt from the same bytes the terminal already printed — no decoder, no
 * second QR library, and no second source of truth about what is being paired.
 *
 * The glyph palette is inverted with respect to the modules: `qrcode-terminal`
 * draws a filled block for two white modules and leaves a space for two black
 * ones, because it assumes a dark terminal background. Reading that the obvious
 * way round produces a QR that is the photographic negative of the real one and
 * never scans.
 */
const MODULES_BY_GLYPH: Record<string, readonly [boolean, boolean]> = {
  "█": [false, false],
  "▀": [false, true],
  "▄": [true, false],
  " ": [true, true],
};

/** The longest run of QR glyphs a line may carry before it stops looking like one. */
const MIN_QR_LINE_CHARS = 30;

/** Terminal colour escapes, which a pseudo-terminal interleaves with the picture. */
// eslint-disable-next-line no-control-regex -- matching an ANSI escape needs the escape character itself.
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/**
 * Whether a line is part of the printed QR, rather than the instructions above it
 * or the "Waiting for scan..." that follows. Blank lines are excluded: the QR's
 * own quiet zone is printed as part of its rows, not as absent lines.
 */
function isQrLine(line: string): boolean {
  return line.length >= MIN_QR_LINE_CHARS && [...line].every((char) => char in MODULES_BY_GLYPH);
}

/**
 * The module matrix the bridge printed, or `null` when this text carries no QR.
 *
 * `qrcode-terminal` wraps the symbol in a one-module white margin and adds a
 * decorative border line above and below. The margin is stripped because the
 * renderer adds its own quiet zone, and the border lines are dropped because
 * they are not part of the symbol. When the module count is odd the library
 * appends a blank row, which leaves the reconstruction one row taller than the
 * symbol; that row is trimmed so the matrix stays square.
 */
export function modulesFromTerminalQr(text: string): boolean[][] | null {
  // The blocks arrive from a pseudo-terminal, so every line carries ANSI colour
  // and a carriage return. Neither is part of the picture, and an unexpected
  // character would make each QR line fail the glyph test below.
  const lines = text.replace(ANSI, "").replace(/\r/g, "").split("\n");
  const rows: boolean[][] = [];
  for (const line of lines) {
    if (!isQrLine(line)) continue;
    const core = line.slice(1, -1);
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const char of core) {
      const pair = MODULES_BY_GLYPH[char];
      if (pair === undefined) return null;
      top.push(pair[0]);
      bottom.push(pair[1]);
    }
    rows.push(top, bottom);
  }
  if (rows.length === 0) return null;

  const width = rows[0]?.length ?? 0;
  // The decorative border is printed as a line of one uniform glyph; the symbol
  // below it is not uniform, so a uniform first or last row is that border.
  const uniform = (row: boolean[]): boolean => row.every((module) => module === row[0]);
  while (rows.length > 0 && uniform(rows[0] ?? [])) rows.shift();
  while (rows.length > 0 && uniform(rows[rows.length - 1] ?? [])) rows.pop();

  if (width === 0 || rows.length < width) return null;
  // The symbol is square, and the library pads an odd module count with one blank
  // row. Taking exactly `width` rows both squares the matrix and discards that pad.
  const square = rows.slice(0, width);
  if (square.some((row) => row.length !== width)) return null;
  return square;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The CRC-32 the PNG chunk format requires, built once per call site. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * An 8-bit greyscale PNG of the matrix, one pixel per module scaled by `scale`
 * and surrounded by a `quietZone`-module white margin. Only black and white
 * values are ever written, so the encoder needs no palette and no filtering.
 */
export function pngFromModules(modules: boolean[][], scale = 8, quietZone = 4): Buffer {
  const moduleCount = modules.length;
  const size = (moduleCount + quietZone * 2) * scale;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type: greyscale
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const stride = size + 1; // one filter byte per scanline
  const raw = Buffer.alloc(stride * size, 0xff);
  for (let y = 0; y < size; y += 1) raw[y * stride] = 0;
  for (let my = 0; my < moduleCount; my += 1) {
    const row = modules[my] ?? [];
    for (let mx = 0; mx < moduleCount; mx += 1) {
      if (row[mx] !== true) continue;
      const y0 = (my + quietZone) * scale;
      const x0 = (mx + quietZone) * scale;
      for (let y = y0; y < y0 + scale; y += 1) raw.fill(0x00, y * stride + 1 + x0, y * stride + 1 + x0 + scale);
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * The `qr` value the console renders: a PNG data URL, or `null` when the text
 * carried no QR. A data URL is the only shape the pairing panel accepts, which is
 * why the PNG is built here rather than an SVG or the raw glyphs.
 */
export function qrDataUrlFromTerminal(text: string): string | null {
  const modules = modulesFromTerminalQr(text);
  if (modules === null) return null;
  return `data:image/png;base64,${pngFromModules(modules).toString("base64")}`;
}
