package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// deviceStore is the auth-store seam: the SQL container behind it holds device
// credentials and protocol state. It is deliberately narrower than
// *sqlstore.Container so restore and logout paths are provable with a fake.
type deviceStore interface {
	NewDevice() *store.Device
	GetAllDevices(ctx context.Context) ([]*store.Device, error)
	DeleteDevice(ctx context.Context, device *store.Device) error
	Close() error
}

// whatsmeowClient is every whatsmeow method the worker uses, in one place
// (§6.1). *whatsmeow.Client satisfies it as-is, and nothing else in the project
// reaches into the library outside these methods.
type whatsmeowClient interface {
	groupClient
	whatsmeowMediaClient

	AddEventHandler(handler whatsmeow.EventHandler) uint32
	RemoveEventHandler(id uint32) bool
	Connect() error
	Disconnect()
	Logout(ctx context.Context) error
	GetQRChannel(ctx context.Context) (<-chan whatsmeow.QRChannelItem, error)
	PairPhone(ctx context.Context, phone string, showPushNotification bool, clientType whatsmeow.PairClientType, clientDisplayName string) (string, error)
	ParseWebMessage(chatJID types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error)
	SendMessage(ctx context.Context, to types.JID, message *waE2E.Message, extra ...whatsmeow.SendRequestExtra) (whatsmeow.SendResponse, error)
}

// whatsmeowNewClient is the one place a real client is built, so the manager's
// seam has a named production value.
func whatsmeowNewClient(device *store.Device, log waLog.Logger) whatsmeowClient {
	return whatsmeow.NewClient(device, log)
}

// newWhatsmeowStore opens the durable auth store (§6.1). Development uses a
// SQLite file inside the git-ignored `.localdata/`; the parent directory is
// created here because SQLite will not create it and the failure otherwise
// surfaces as a confusing "unable to open database file".
func newWhatsmeowStore(ctx context.Context, uri string) (*sqlstore.Container, error) {
	if dir := sqliteDir(uri); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("auth store directory: %w", err)
		}
	}
	container, err := sqlstore.New(ctx, "sqlite3", uri, waLog.Stdout("whatsmeow", "WARN", false))
	if err != nil {
		return nil, fmt.Errorf("whatsmeow auth store: %w", err)
	}
	return container, nil
}

// sqliteDir returns the directory a `file:` SQLite URI points at, or "" when
// the URI is not a file path (an in-memory or non-SQLite DSN needs no mkdir).
func sqliteDir(uri string) string {
	if !strings.HasPrefix(uri, "file:") {
		return ""
	}
	path := strings.TrimPrefix(uri, "file:")
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	if path == "" || path == ":memory:" {
		return ""
	}
	dir := filepath.Dir(path)
	if dir == "." || dir == "" || dir == "/" {
		return ""
	}
	return dir
}

func (m *manager) waLogger() waLog.Logger {
	return waLog.Stdout("whatsmeow", "WARN", false)
}

// openSession links a live client to its auth device and registers the single
// event dispatcher before anything connects, so no event can arrive without a
// handler (§6.1).
func (m *manager) openSession(row InstanceRow, device *store.Device) (*session, error) {
	if device == nil {
		return nil, errors.New("instance has no auth device")
	}
	client := m.newClient(device, m.waLogger())
	s := newSession(m, row, device, client)
	s.handlerID = client.AddEventHandler(func(evt any) { handleEvent(s, evt) })
	m.put(s)
	return s, nil
}

// beginPairing creates a fresh device, opens the QR channel *before* Connect
// (whatsmeow's contract), connects, and starts consuming the channel.
func (m *manager) beginPairing(row InstanceRow) (*session, error) {
	s, err := m.openSession(row, m.devices.NewDevice())
	if err != nil {
		return nil, err
	}
	qrChan, err := s.client.GetQRChannel(m.ctx)
	if err != nil {
		m.discard(s)
		return nil, fmt.Errorf("open qr channel: %w", err)
	}
	if err := s.client.Connect(); err != nil {
		m.discard(s)
		return nil, fmt.Errorf("connect: %w", err)
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.consumePairing(s, qrChan)
	}()
	return s, nil
}

// consumePairing turns the whatsmeow QR channel into persisted pairing
// material. The first payload also marks the login websocket ready, which is
// the point PairPhone may be called. "success" is not treated as connected
// here: the authoritative transition is the *events.Connected handler, so the
// status and sync run exactly once.
func (m *manager) consumePairing(s *session, qrChan <-chan whatsmeow.QRChannelItem) {
	for {
		select {
		case <-m.ctx.Done():
			return
		case item, ok := <-qrChan:
			if !ok {
				return
			}
			s.readyOnce.Do(func() { close(s.pairingReady) })
			switch item.Event {
			case whatsmeow.QRChannelEventCode:
				if s.mode != modeQR {
					continue
				}
				if err := m.publishQR(s, item.Code); err != nil {
					logf("instance %s: publish qr: %v", s.id, err)
				}
			case whatsmeow.QRChannelSuccess.Event:
				logf("instance %s: pairing accepted, waiting for connected", s.id)
				return
			case whatsmeow.QRChannelEventError:
				m.failPairing(s, item.Error)
				return
			default:
				reason := item.Event
				if item.Error != nil {
					reason = item.Error.Error()
				}
				m.failPairing(s, errors.New(reason))
				return
			}
		}
	}
}

// publishQR renders one QR payload as a PNG data URL and persists it for the
// BFF's pairing screen (§6.1).
func (m *manager) publishQR(s *session, code string) error {
	if code == "" {
		return nil
	}
	url, err := qrDataURL(code)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.status = statePairing
	s.qrDataURL = url
	s.mu.Unlock()
	return m.pairing.Put(m.ctx, pairingSession{
		InstanceID:     s.id,
		OrganizationID: m.orgID,
		Mode:           s.mode,
		QRDataURL:      url,
	})
}

// failPairing records a terminal pairing failure in both the live session and
// the persisted row, and leaves an audit trail.
func (m *manager) failPairing(s *session, cause error) {
	reason := "pairing failed"
	if cause != nil {
		reason = cause.Error()
	}
	ctx := context.WithoutCancel(m.ctx)
	if err := m.markStatus(ctx, s.id, stateError, reason); err != nil {
		logf("instance %s: persist pairing failure: %v", s.id, err)
	}
	if err := m.pairing.Put(ctx, pairingSession{
		InstanceID:     s.id,
		OrganizationID: m.orgID,
		Mode:           s.mode,
		Error:          reason,
	}); err != nil {
		logf("instance %s: persist pairing failure material: %v", s.id, err)
	}
	if m.audit != nil {
		if err := m.audit.append(ctx, m.orgID, "instance.pairing_failed", "instance", s.id, bson.M{"error": reason}); err != nil {
			logf("instance %s: audit pairing failure: %v", s.id, err)
		}
	}
}

// requestPairingCode produces (or re-requests) the phone pairing code for a
// code-mode instance (POST /instances/{id}/pairing-code). It waits for the
// connection to be ready rather than sleeping a guessed duration.
func (m *manager) requestPairingCode(ctx context.Context, id string) (instanceSnapshot, error) {
	row, err := m.instances.Get(ctx, m.orgID, id)
	if err != nil {
		return instanceSnapshot{}, err
	}
	if row == nil {
		return instanceSnapshot{}, errInstanceNotFound
	}
	s := m.get(id)
	if s == nil {
		return instanceSnapshot{}, fmt.Errorf("%w: instance has no live session", errPairingNotReady)
	}
	if s.mode != modeCode {
		return instanceSnapshot{}, errWrongMode
	}
	phone := normalizePhone(s.snapshot().PhoneNumber)
	if phone == "" {
		phone = normalizePhone(row.PhoneNumber)
	}
	if phone == "" {
		return instanceSnapshot{}, fmt.Errorf("%w: phoneNumber is required for code pairing", errInvalidRequest)
	}
	select {
	case <-s.pairingReady:
	case <-time.After(pairingReadyWait):
		return instanceSnapshot{}, fmt.Errorf("%w: the login websocket did not become ready", errPairingNotReady)
	case <-ctx.Done():
		return instanceSnapshot{}, ctx.Err()
	}
	code, err := s.client.PairPhone(ctx, phone, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
	if err != nil {
		return instanceSnapshot{}, fmt.Errorf("request pairing code: %w", err)
	}
	s.mu.Lock()
	s.status = statePairing
	s.pairingCode = code
	s.mu.Unlock()
	if err := m.pairing.Put(ctx, pairingSession{
		InstanceID:     s.id,
		OrganizationID: m.orgID,
		Mode:           s.mode,
		PairingCode:    code,
	}); err != nil {
		logf("instance %s: persist pairing code: %v", s.id, err)
	}
	return m.getInstance(ctx, id)
}

const pairingReadyWait = 15 * time.Second

// qrDataURL encodes the raw QR payload as a PNG data URL. The dashboard renders
// the image directly; the BFF never sees the raw string.
func qrDataURL(code string) (string, error) {
	png, err := qrcode.Encode(code, qrcode.Medium, 512)
	if err != nil {
		return "", fmt.Errorf("render qr code: %w", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

// reconcileInstances repairs persisted `runtime.status` from the auth store
// before anything reconnects. It is the deterministic recovery for a transition
// that never landed (a crash mid-drain, a queue the shutdown deadline cut off):
// without it, a row could claim `connected` for a credential that no longer
// exists, or `pairing` for a QR session that died with the previous process.
//
// A read failure is transient and leaves the row alone (the next start retries);
// only facts the auth store proves are written.
func reconcileInstances(ctx context.Context, m *manager) {
	rows, err := m.instances.List(ctx, m.orgID)
	if err != nil {
		logf("reconcile: list instances: %v", err)
		return
	}
	byPhone, err := m.devicesByPhone(ctx)
	if err != nil {
		logf("reconcile: read auth devices: %v", err)
		return
	}
	repaired := 0
	for _, row := range rows {
		switch row.Status {
		case stateConnected:
			if phone := normalizePhone(row.PhoneNumber); phone != "" {
				if _, ok := byPhone[phone]; !ok {
					// The credential is gone: the link does not exist, whatever
					// the row says.
					m.reconcileStatus(ctx, row, stateLoggedOut, "")
					repaired++
				}
			}
		case statePairing:
			// A pairing that was in flight when the process stopped cannot be
			// resumed: the QR/login websocket died with it.
			if _, ok := byPhone[normalizePhone(row.PhoneNumber)]; !ok {
				m.reconcileStatus(ctx, row, stateError, "pairing interrupted; restart to retry")
				repaired++
			}
		}
	}
	if repaired > 0 {
		logf("reconcile: repaired %d stale instance status(es)", repaired)
	}
}

// reconcileStatus writes one repaired status and audits it, so a state change no
// event produced is still traceable.
func (m *manager) reconcileStatus(ctx context.Context, row InstanceRow, status sessionState, reason string) {
	if err := m.instances.SetStatus(ctx, m.orgID, row.ID, status, reason); err != nil {
		logf("reconcile: instance %s -> %s: %v", row.ID, status, err)
		return
	}
	if m.audit != nil {
		if err := m.audit.append(ctx, m.orgID, "instance.reconciled", "instance", row.ID, bson.M{
			"from":   string(row.Status),
			"to":     string(status),
			"reason": reason,
		}); err != nil {
			logf("reconcile: audit instance %s: %v", row.ID, err)
		}
	}
}

// restoreInstances reconnects every persisted instance whose own auth device is
// still present. It never substitutes another device, and it refuses a device
// already owned by a live session, which is what keeps one linked account from
// appearing as several instances (§6.1).
func restoreInstances(ctx context.Context, m *manager) {
	rows, err := m.instances.List(ctx, m.orgID)
	if err != nil {
		logf("restore: list instances: %v", err)
		return
	}
	byPhone, err := m.devicesByPhone(ctx)
	if err != nil {
		logf("restore: read auth devices: %v", err)
		return
	}
	rowsByID := make(map[string]InstanceRow, len(rows))
	for _, row := range rows {
		rowsByID[row.ID] = row
	}
	ids := restorableInstances(rows, func(phone string) bool {
		_, ok := byPhone[phone]
		return ok
	})
	if len(ids) == 0 {
		logf("restore: no instances to restore")
		return
	}
	live := m.liveDevices()
	restored := 0
	for _, id := range ids {
		row := rowsByID[id]
		device := byPhone[normalizePhone(row.PhoneNumber)]
		if deviceOwnedByOther(live, id, device.GetJID()) {
			logf("instance %s: device %s is owned by another live session, not restoring", id, device.GetJID())
			continue
		}
		s, err := m.openSession(row, device)
		if err != nil {
			logf("instance %s: open session: %v", id, err)
			_ = m.markStatus(ctx, id, stateError, err.Error())
			continue
		}
		s.status = stateDisconnected
		if err := s.client.Connect(); err != nil {
			m.discard(s)
			logf("instance %s: reconnect: %v", id, err)
			_ = m.markStatus(ctx, id, stateError, err.Error())
			continue
		}
		live[id] = device.GetJID()
		restored++
	}
	logf("restore: reconnected %d of %d eligible instance(s)", restored, len(ids))
}

// devicesByPhone indexes the auth store by bare phone digits. The device JID is
// an AD JID (`phone:device`), so looking it up by the persisted phone directly
// would never match; the digits are the stable identity.
func (m *manager) devicesByPhone(ctx context.Context) (map[string]*store.Device, error) {
	devices, err := m.devices.GetAllDevices(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]*store.Device, len(devices))
	for _, device := range devices {
		if phone := phoneDigitsFromJID(device.GetJID()); phone != "" {
			out[phone] = device
		}
	}
	return out, nil
}

// deviceForPhone finds the auth device whose phone digits match, or nil.
func (m *manager) deviceForPhone(ctx context.Context, phone string) (*store.Device, error) {
	phone = normalizePhone(phone)
	if phone == "" {
		return nil, nil
	}
	devices, err := m.devicesByPhone(ctx)
	if err != nil {
		return nil, err
	}
	return devices[phone], nil
}

// markStatus persists a runtime status change and mirrors it on the live
// session when one exists.
func (m *manager) markStatus(ctx context.Context, id string, status sessionState, pairingError string) error {
	if s := m.get(id); s != nil {
		s.mu.Lock()
		s.status = status
		s.pairingError = pairingError
		s.mu.Unlock()
	}
	return m.instances.SetStatus(ctx, m.orgID, id, status, pairingError)
}

// markConnectedLocal applies the in-memory half of the connected transition:
// status and identity become visible immediately, so group/media lookups can
// use the client from the next statement on. The Mongo write and the connect
// sync are queued (instanceConnectedJob) — they must not run on the whatsmeow
// callback.
func (m *manager) markConnectedLocal(s *session) {
	jid := s.deviceJID()
	phone := phoneDigitsFromJID(jid)
	lid := ""
	if s.device != nil && !s.device.LID.IsEmpty() {
		lid = s.device.LID.String()
	}
	at := now().UTC()
	s.mu.Lock()
	s.status = stateConnected
	s.phoneNumber = phone
	s.botJID = jid.String()
	s.botLID = lid
	s.pairingError = ""
	s.qrDataURL = ""
	s.pairingCode = ""
	s.connectedAt = at
	s.lastSeenAt = at
	s.mu.Unlock()
}

// instanceConnectedJob persists the connected state and starts the connect-time
// sync. It runs on the ordered lifecycle consumer, and it spawns the sync rather
// than performing it here so a slow WhatsApp IQ cannot block later transitions.
type instanceConnectedJob struct{ session *session }

func (j instanceConnectedJob) persist(ctx context.Context, m *manager) error {
	s := j.session
	if s == nil {
		return nil
	}
	snap := s.snapshot()
	if err := m.instances.SetConnected(ctx, m.orgID, s.id, snap.PhoneNumber, snap.BotJID, snap.BotLID); err != nil {
		return err
	}
	if err := m.pairing.Clear(ctx, m.orgID, s.id); err != nil {
		return err
	}
	m.syncGroupsOnConnect(s)
	return nil
}

// instanceStatusJob persists one runtime status change.
type instanceStatusJob struct {
	instanceID   string
	status       sessionState
	pairingError string
}

func (j instanceStatusJob) persist(ctx context.Context, m *manager) error {
	return m.instances.SetStatus(ctx, m.orgID, j.instanceID, j.status, j.pairingError)
}

// instanceLoggedOutJob performs the permanent-unlink cleanup off the callback:
// persist the status, drop pairing material, delete the now-useless auth device
// (SQLite) and leave an audit trail. Every step is attempted so one failure
// cannot leave the others undone; the joined error tells the queue this job
// failed.
type instanceLoggedOutJob struct {
	session *session
	botJID  types.JID
}

func (j instanceLoggedOutJob) persist(ctx context.Context, m *manager) error {
	s := j.session
	if s == nil {
		return nil
	}
	var errs []error
	if err := m.instances.SetStatus(ctx, m.orgID, s.id, stateLoggedOut, ""); err != nil {
		errs = append(errs, err)
	}
	if err := m.pairing.Clear(ctx, m.orgID, s.id); err != nil {
		errs = append(errs, err)
	}
	if device, err := m.deviceForPhone(ctx, phoneDigitsFromJID(j.botJID)); err != nil {
		errs = append(errs, err)
	} else if device != nil {
		if err := m.devices.DeleteDevice(ctx, device); err != nil {
			errs = append(errs, err)
		}
	}
	if m.audit != nil {
		if err := m.audit.append(ctx, m.orgID, "instance.logged_out", "instance", s.id, bson.M{"botJid": j.botJID.String()}); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// syncGroupsOnConnect runs the connect-time full sync off the event loop: a
// slow IQ must not stall message ingest. A failure writes nothing about
// membership, so a timed-out sync is never mistaken for "we left every group"
// (§6.6.5).
func (m *manager) syncGroupsOnConnect(s *session) {
	go m.runGroupSyncOnce(m.ctx, s, SyncOnConnect)
}

// runGroupSyncOnce performs one full sync for one session under its own
// deadline. It is shared by the connect-time sync and the GROUP_SYNC_INTERVAL
// scheduler, so both paths reconcile identically.
func (m *manager) runGroupSyncOnce(ctx context.Context, s *session, source SyncSource) {
	s.mu.Lock()
	client := s.client
	s.mu.Unlock()
	if client == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, groupSyncTimeout)
	defer cancel()
	summary, err := runGroupSync(ctx, client, m.groups, m.orgID, s.id, source, m.cfg.GroupSyncPrune)
	if err != nil {
		logf("instance %s: group sync (%s): %v", s.id, source, err)
		return
	}
	logf("instance %s: group sync (%s): %d group(s), %d added, %d marked left",
		s.id, source, summary.Total, summary.Added, summary.MarkedLeft)
}

// runGroupSyncScheduler performs the periodic full reconcile (§6.6.2) until its
// context is cancelled. It is the offline-rename safety net: without it, a
// rename that happened while the worker was down would go unseen.
func (m *manager) runGroupSyncScheduler(ctx context.Context) {
	ticks, stop := m.newTicker(m.cfg.GroupSyncInterval)
	defer stop()
	logf("group sync scheduler started (every %s)", m.cfg.GroupSyncInterval)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			m.syncAllConnected(ctx)
		}
	}
}

// syncAllConnected runs one timer-driven sync for every instance with a live
// client. An offline instance has nothing to ask, so it is skipped rather than
// recorded as a failed sync.
func (m *manager) syncAllConnected(ctx context.Context) {
	for _, s := range m.listActive() {
		if m.groupClient(s.id) == nil {
			continue
		}
		m.runGroupSyncOnce(ctx, s, SyncOnTimer)
	}
}

const groupSyncTimeout = time.Minute

// releaseLoggedOut applies the in-memory half of the logout: the client is
// disconnected and the session leaves the map immediately, so no further event
// or request is served for it. The Mongo status and the SQLite credential
// cleanup are queued on the ordered lifecycle consumer.
func (m *manager) releaseLoggedOut(s *session) {
	botJID := s.deviceJID()
	if s.client != nil {
		s.client.Disconnect()
	}
	m.discard(s)
	m.enqueueLifecycle(instanceLoggedOutJob{session: s, botJID: botJID})
}
