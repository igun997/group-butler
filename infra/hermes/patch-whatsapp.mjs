#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  console.error("usage: patch-whatsapp.mjs <whatsapp.py> <output-path>");
  process.exit(2);
}

const source = readFileSync(sourcePath, "utf8");
const anchor = `    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
    ) -> SendResult:`;
const replacement = `    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:`;

const occurrences = source.split(anchor).length - 1;
if (occurrences !== 1) {
  console.error(`patch-whatsapp: expected exactly one send_image signature in ${sourcePath}, found ${occurrences}`);
  process.exit(1);
}

const patched = source.replace(anchor, replacement);
writeFileSync(outputPath, patched, "utf8");
console.log(`patched ${sourcePath} -> ${outputPath}`);
