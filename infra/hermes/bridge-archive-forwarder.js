const MAX_MESSAGE_LENGTH = parseInt(process.env.WHATSAPP_MAX_MESSAGE_LENGTH || '4096', 10);

// ── Archive forwarder (added by group-butler; see infra/hermes/patch-bridge.mjs) ──
//
// Every inbound message is reported to the archive endpoint before the gateway
// decides whether the agent should see it, so a group's chatter is recorded even
// when nothing wakes the agent. Attachments travel as the paths the bridge just
// wrote, because the archive runs where that volume is readable.
//
// This must never affect delivery: the caller fires it without awaiting and
// swallows rejections, because a message the agent would have answered must not
// be lost to a slow or unreachable archive.
const ARCHIVE_URL = process.env.WHATSAPP_ARCHIVE_URL || '';
const ARCHIVE_SECRET = process.env.WHATSAPP_ARCHIVE_SECRET || '';
const ARCHIVE_TIMEOUT_MS = parseInt(process.env.WHATSAPP_ARCHIVE_TIMEOUT_MS || '10000', 10);

async function archiveForward(payload) {
  if (!ARCHIVE_URL) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ARCHIVE_TIMEOUT_MS);
  try {
    await fetch(ARCHIVE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ARCHIVE_SECRET}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
// ── end archive forwarder ──
