// ── Group action endpoints (added by group-butler; see infra/hermes/patch-bridge.mjs) ──
//
// Hermes's bridge can send and edit messages, and nothing else: it cannot rename
// a group, change who is in it, or revoke anything. Those are exactly the
// operations group-butler's tools perform, and until they exist here the console
// can only read. Baileys supports all of them, so this exposes the missing half
// on the same local HTTP surface the bridge already offers.
//
// The shapes mirror the worker's existing group-admin contract so the caller's
// validation, audit writes and partial-success handling keep working unchanged.
// In particular `groupParticipantsUpdate` reports per-JID outcomes, and a run
// that WhatsApp did not confirm for every JID must come back `ok:false` with the
// failures named — not as a failure of the whole call.

function bridgeGroupReady(res) {
  if (sock) return true;
  res.status(503).json({ ok: false, error: 'whatsapp is not connected' });
  return false;
}

function bridgeGroupFailed(res, err) {
  res.status(500).json({ ok: false, error: String((err && err.message) || err) });
}

app.get('/group/:jid', async (req, res) => {
  if (!bridgeGroupReady(res)) return;
  try {
    const md = await sock.groupMetadata(req.params.jid);
    res.json({
      ok: true,
      subject: md.subject || '',
      announce: md.announce === true,
      locked: md.restrict === true,
      participants: (md.participants || []).map((p) => ({ jid: p.id, admin: p.admin || null })),
    });
  } catch (err) {
    bridgeGroupFailed(res, err);
  }
});

// Every group this account is in, which is the one question a group *sync* asks
// and the reason the worker still held a WhatsApp session of its own. Without
// this the console could only learn about a group someone had already told it
// about, so a group the account was added to silently stayed invisible.
app.get('/groups', async (req, res) => {
  if (!bridgeGroupReady(res)) return;
  try {
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all || {}).map((md) => ({
      jid: md.id,
      subject: md.subject || '',
      announce: md.announce === true,
      locked: md.restrict === true,
      participantCount: (md.participants || []).length,
    }));
    res.json({ ok: true, groups });
  } catch (err) {
    bridgeGroupFailed(res, err);
  }
});

app.post('/group/rename', async (req, res) => {
  if (!bridgeGroupReady(res)) return;
  const { jid, subject } = req.body || {};
  if (!jid || typeof subject !== 'string') return res.status(400).json({ ok: false, error: 'jid and subject are required' });
  try {
    await sock.groupUpdateSubject(jid, subject);
    res.json({ ok: true });
  } catch (err) {
    bridgeGroupFailed(res, err);
  }
});

app.post('/group/settings', async (req, res) => {
  if (!bridgeGroupReady(res)) return;
  const { jid, announce, locked } = req.body || {};
  if (!jid) return res.status(400).json({ ok: false, error: 'jid is required' });
  if (announce === undefined && locked === undefined) {
    return res.status(400).json({ ok: false, error: 'announce or locked is required' });
  }
  try {
    // Two independent switches on the same group, so each is applied on its own
    // terms: a locked change that WhatsApp refuses must not be reported as an
    // announce change that succeeded.
    if (announce !== undefined) await sock.groupSettingUpdate(jid, announce ? 'announcement' : 'not_announcement');
    if (locked !== undefined) await sock.groupSettingUpdate(jid, locked ? 'locked' : 'unlocked');
    res.json({ ok: true });
  } catch (err) {
    bridgeGroupFailed(res, err);
  }
});

app.post('/group/photo', async (req, res) => {
  if (!bridgeGroupReady(res)) return;
  const { jid, dataUrl } = req.body || {};
  if (!jid || typeof dataUrl !== 'string') return res.status(400).json({ ok: false, error: 'jid and dataUrl are required' });
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma === -1) {
    return res.status(400).json({ ok: false, error: 'dataUrl must be a data URL' });
  }
  try {
    const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    const updated = await sock.updateProfilePicture(jid, buf);
    res.json({ ok: true, pictureId: (updated && updated.id) || '' });
  } catch (err) {
    bridgeGroupFailed(res, err);
  }
});

app.post('/group/participants', async (req, res) => {
  if (!bridgeGroupReady(res)) return;
  const { jid, membership, participants } = req.body || {};
  const allowed = ['add', 'remove', 'promote', 'demote'];
  if (!jid || !allowed.includes(membership) || !Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ ok: false, error: 'jid, membership and a non-empty participants list are required' });
  }
  try {
    const raw = await sock.groupParticipantsUpdate(jid, participants, membership);
    const results = (raw || []).map((entry) => ({
      jid: entry.jid,
      // Baileys answers with an HTTP-ish status string; "200" is the only one
      // that means WhatsApp applied it to that member.
      ok: String(entry.status) === '200',
      error: String(entry.status) === '200' ? '' : String(entry.status),
    }));
    const failed = results.filter((r) => !r.ok).map((r) => r.jid);
    res.json({ ok: failed.length === 0, results, failed });
  } catch (err) {
    bridgeGroupFailed(res, err);
  }
});

app.post('/group/leave', async (req, res) => {
  if (!bridgeGroupReady(res)) return;
  const { jid } = req.body || {};
  if (!jid) return res.status(400).json({ ok: false, error: 'jid is required' });
  try {
    await sock.groupLeave(jid);
    res.json({ ok: true });
  } catch (err) {
    bridgeGroupFailed(res, err);
  }
});

app.post('/message/revoke', async (req, res) => {
  if (!bridgeGroupReady(res)) return;
  const { jid, messageId } = req.body || {};
  if (!jid || !messageId) return res.status(400).json({ ok: false, error: 'jid and messageId are required' });
  try {
    // A revoke is addressed by the message's own key, not by the chat alone, and
    // fromMe must be set: the assistant only ever revokes what it sent.
    await sock.sendMessage(jid, { delete: { remoteJid: jid, id: messageId, fromMe: true } });
    res.json({ ok: true, revokeMessageId: messageId });
  } catch (err) {
    bridgeGroupFailed(res, err);
  }
});
// ── end group action endpoints ──
