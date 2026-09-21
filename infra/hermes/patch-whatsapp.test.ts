import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DIR = import.meta.dir;

test("patched WhatsApp image sender accepts base metadata argument", () => {
  const work = mkdtempSync(join(tmpdir(), "patch-whatsapp-"));
  const source = join(work, "whatsapp.py");
  const output = join(work, "patched.py");
  writeFileSync(
    source,
    [
      "from __future__ import annotations",
      "from typing import Any, Dict, Optional",
      "SendResult = bool",
      "",
      "class WhatsAppAdapter:",
      "    async def send_image(",
      "        self,",
      "        chat_id: str,",
      "        image_url: str,",
      "        caption: Optional[str] = None,",
      "        reply_to: Optional[str] = None,",
      "    ) -> SendResult:",
      "        return bool(chat_id and image_url)",
      "",
    ].join("\n"),
  );

  const patch = spawnSync("node", [join(DIR, "patch-whatsapp.mjs"), source, output], {
    encoding: "utf8",
  });
  expect(patch.status, patch.stderr).toBe(0);
  expect(readFileSync(output, "utf8")).toContain("metadata: Optional[Dict[str, Any]] = None,");

  const call = spawnSync(
    "python3",
    [
      "-c",
      [
        "import asyncio, importlib.util, sys",
        "spec = importlib.util.spec_from_file_location('patched', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "result = asyncio.run(module.WhatsAppAdapter().send_image(chat_id='g@g.us', image_url='https://example.test/a.png', metadata={'source': 'fal'}))",
        "assert result is True",
      ].join("; "),
      output,
    ],
    { encoding: "utf8" },
  );
  expect(call.status, call.stderr).toBe(0);
});
