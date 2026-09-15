package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/types"
)

const (
	developmentEnv = "development"
	productionEnv  = "production"

	// devWorkerSecret is the local placeholder from `.env.example`. Production
	// refuses to boot while WORKER_SECRET is missing or still this value.
	devWorkerSecret = "dev-secret"

	// devMemoryCallbackSecret is documented for local wiring only. Production
	// refuses it so an internet-facing callback cannot share a public secret.
	devMemoryCallbackSecret = "dev-memory-callback-secret"

	devMongoURI = "mongodb://127.0.0.1:27017/group_butler?replicaSet=rs0"

	// devWhatsmeowURI mirrors the value root `.env.example` supplies, so the
	// fallback stays inside the git-ignored apps/worker/.localdata/. Deployment
	// sets the mounted-volume path explicitly (apps/worker/.env.production.example).
	devWhatsmeowURI = "file:./.localdata/whatsmeow.db?_foreign_keys=on"

	// fallbackCountryCode is the country a national-form owner number is
	// expanded with when DEFAULT_COUNTRY_CODE is unusable. It is the BFF's
	// FALLBACK_COUNTRY_CODE: if the two sides expand the same number with
	// different codes, the reply gate compares two different people.
	fallbackCountryCode = "62"
)

// Config is the worker's whole runtime configuration, read from the
// environment once at startup (docs/architecture-draft.md §6.9). Duration and
// size knobs are already typed and validated, so no caller re-parses strings.
type Config struct {
	Environment    string
	Port           string
	WorkerSecret   string
	OrganizationID string
	MongoURI       string
	MongoDB        string
	WhatsmeowDB    string
	R2AccountID    string
	R2AccessKeyID  string
	R2SecretKey    string
	R2Bucket       string
	R2PublicURL    string

	// OwnerWhatsAppJID is an optional, informational owner identity: it is
	// normalized at startup when set and ignored when not. It does not gate
	// anything — the BFF authorizes a mention's sender against the owner list it
	// stores in Mongo, which is the same list the dashboard edits. The reply
	// callback pair below is what actually delivers a mention, so those two are
	// required together and nothing else is.
	OwnerWhatsAppJID    string
	ReplyCallbackURL    string
	ReplyCallbackSecret string

	// DefaultCountryCode is the country an operator leaves off when they write
	// their own number in national form (`0899…`), shared with the BFF. A
	// mismatch expands the same digits into different people, so the reply gate
	// would never see the owner.
	DefaultCountryCode string

	MemoryCallbackURL      string
	MemoryCallbackSecret   string
	MemoryBatchEvery       time.Duration
	MemoryBatchConcurrency int

	IngestQueueSize int
	IngestFlush     time.Duration
	IngestFlushMax  int
	RawJSONMaxBytes int
	RawSearchMax    int

	// Event persistence bounds the queue that carries Mongo work off the
	// whatsmeow event loop (§6.2). It is separate from the ingest queue: a
	// message batch and a group delta have different volume and failure modes.
	EventQueueSize int
	EventWorkers   int

	MediaMaxBytes        int64
	MediaConcurrency     int
	MediaDownloadTimeout time.Duration
	MediaMaxAttempts     int
	MediaJanitorEvery    time.Duration
	MediaEnrichEnabled   bool

	GroupSyncInterval time.Duration
	GroupStaleAfter   time.Duration
	GroupSyncPrune    bool

	DispatchInterval time.Duration
	SendMaxAttempts  int

	HistorySyncMaxDays int

	AIBaseURL string
	AIAPIKey  string
	AIModel   string

	LogLevel string
}

// ListenAddr is the address the control API binds. The port is always the
// documented one, with the local default restored if PORT was blank.
func (c Config) ListenAddr() string {
	if c.Port == "" {
		return ":4000"
	}
	return ":" + c.Port
}

// loadConfig reads and validates the worker's environment. A malformed
// duration is an error rather than a silent fallback: a typo in a timeout must
// not start a process with the wrong one. Production additionally refuses the
// development defaults (§6.9).
func loadConfig() (Config, error) {
	cfg := Config{
		Environment:    env("ENVIRONMENT", developmentEnv),
		Port:           env("PORT", "4000"),
		WorkerSecret:   env("WORKER_SECRET", devWorkerSecret),
		OrganizationID: env("ORGANIZATION_ID", "org_default"),
		MongoURI:       env("MONGODB_URI", devMongoURI),
		MongoDB:        env("MONGODB_DB", "group_butler"),
		WhatsmeowDB:    env("WHATSMEOW_DB_URI", devWhatsmeowURI),

		R2AccountID:   os.Getenv("R2_ACCOUNT_ID"),
		R2AccessKeyID: os.Getenv("R2_ACCESS_KEY_ID"),
		R2SecretKey:   os.Getenv("R2_SECRET_ACCESS_KEY"),
		R2Bucket:      os.Getenv("R2_BUCKET"),
		R2PublicURL:   os.Getenv("R2_PUBLIC_URL"),

		IngestQueueSize: envInt("INGEST_QUEUE_SIZE", 512),
		IngestFlush:     time.Duration(envInt("INGEST_FLUSH_MS", 250)) * time.Millisecond,
		IngestFlushMax:  envInt("INGEST_FLUSH_MAX", 100),
		RawJSONMaxBytes: envInt("RAW_JSON_MAX_BYTES", 32768),
		RawSearchMax:    envInt("RAW_SEARCH_MAX_BYTES", 8192),

		EventQueueSize: envInt("EVENT_QUEUE_SIZE", 1024),
		EventWorkers:   envInt("EVENT_WORKERS", 4),

		MediaMaxBytes:      int64(envInt("MEDIA_MAX_BYTES", 25*1024*1024)),
		MediaConcurrency:   envInt("MEDIA_CONCURRENCY", 4),
		MediaMaxAttempts:   envInt("MEDIA_MAX_ATTEMPTS", 3),
		MediaEnrichEnabled: envBool("MEDIA_ENRICH_ENABLED", false),

		GroupSyncPrune:     envBool("GROUP_SYNC_PRUNE", true),
		SendMaxAttempts:    envInt("SEND_MAX_ATTEMPTS", 3),
		HistorySyncMaxDays: envInt("HISTORY_SYNC_MAX_DAYS", 30),

		MemoryCallbackURL:      os.Getenv("MEMORY_CALLBACK_URL"),
		MemoryCallbackSecret:   os.Getenv("MEMORY_CALLBACK_SECRET"),
		MemoryBatchConcurrency: envInt("MEMORY_BATCH_CONCURRENCY", 2),

		AIBaseURL: os.Getenv("AI_BASE_URL"),
		AIAPIKey:  os.Getenv("AI_API_KEY"),
		AIModel:   os.Getenv("AI_MODEL"),

		OwnerWhatsAppJID:    os.Getenv("OWNER_WHATSAPP_JID"),
		ReplyCallbackURL:    os.Getenv("REPLY_CALLBACK_URL"),
		ReplyCallbackSecret: os.Getenv("REPLY_CALLBACK_SECRET"),
		DefaultCountryCode:  os.Getenv("DEFAULT_COUNTRY_CODE"),

		LogLevel: env("LOG_LEVEL", "info"),
	}

	for _, d := range []struct {
		key    string
		target *time.Duration
		def    time.Duration
	}{
		{"MEDIA_DOWNLOAD_TIMEOUT", &cfg.MediaDownloadTimeout, 45 * time.Second},
		{"MEDIA_JANITOR_INTERVAL", &cfg.MediaJanitorEvery, 5 * time.Minute},
		{"GROUP_SYNC_INTERVAL", &cfg.GroupSyncInterval, 30 * time.Minute},
		{"GROUP_STALE_AFTER", &cfg.GroupStaleAfter, 6 * time.Hour},
		{"DISPATCH_INTERVAL", &cfg.DispatchInterval, 5 * time.Second},
		{"MEMORY_BATCH_INTERVAL", &cfg.MemoryBatchEvery, 30 * time.Second},
	} {
		v, err := envDuration(d.key, d.def)
		if err != nil {
			return Config{}, err
		}
		*d.target = v
	}

	if err := cfg.validate(); err != nil {
		return Config{}, err
	}

	if cfg.Environment == productionEnv {
		// The dev defaults above are local affordances. Deployment gets no
		// implicit localhost database, no relative auth-store path that would
		// land in the image working directory, and no placeholder bearer token.
		if os.Getenv("MONGODB_URI") == "" {
			return Config{}, errors.New("MONGODB_URI is required when ENVIRONMENT=production")
		}
		if os.Getenv("WHATSMEOW_DB_URI") == "" {
			return Config{}, errors.New("WHATSMEOW_DB_URI is required when ENVIRONMENT=production")
		}
		switch cfg.WorkerSecret {
		case "":
			return Config{}, errors.New("WORKER_SECRET is required when ENVIRONMENT=production")
		case devWorkerSecret:
			return Config{}, errors.New("WORKER_SECRET must not be the development default when ENVIRONMENT=production")
		}
		if cfg.MemoryCallbackSecret == devMemoryCallbackSecret {
			return Config{}, errors.New("MEMORY_CALLBACK_SECRET must not be the development default when ENVIRONMENT=production")
		}
	}

	// Every gate above has passed, so this is the configuration the worker will
	// run with: bind the parser's raw-tree caps to it once, here. A rejected
	// configuration returns above and never becomes the parser's limits.
	applyRawLimits(cfg)

	return cfg, nil
}

// validate rejects configurations the worker could not run with. Every count,
// cap, and interval is positive-only: an empty queue or a zero cap stores
// nothing, a zero concurrency or attempt budget can never finish, and a zero
// interval either spins a loop or panics time.NewTicker. PORT is excluded (a
// blank port falls back to the documented one) and so are the booleans.
func (c *Config) validate() error {
	for _, v := range []struct {
		key   string
		value time.Duration
	}{
		{"INGEST_FLUSH_MS", c.IngestFlush},
		{"MEDIA_DOWNLOAD_TIMEOUT", c.MediaDownloadTimeout},
		{"MEDIA_JANITOR_INTERVAL", c.MediaJanitorEvery},
		{"GROUP_SYNC_INTERVAL", c.GroupSyncInterval},
		{"GROUP_STALE_AFTER", c.GroupStaleAfter},
		{"DISPATCH_INTERVAL", c.DispatchInterval},
		{"MEMORY_BATCH_INTERVAL", c.MemoryBatchEvery},
	} {
		if v.value <= 0 {
			return fmt.Errorf("%s must be positive, got %s", v.key, v.value)
		}
	}
	for _, v := range []struct {
		key   string
		value int64
	}{
		{"INGEST_QUEUE_SIZE", int64(c.IngestQueueSize)},
		{"INGEST_FLUSH_MAX", int64(c.IngestFlushMax)},
		{"EVENT_QUEUE_SIZE", int64(c.EventQueueSize)},
		{"EVENT_WORKERS", int64(c.EventWorkers)},
		{"RAW_JSON_MAX_BYTES", int64(c.RawJSONMaxBytes)},
		{"RAW_SEARCH_MAX_BYTES", int64(c.RawSearchMax)},
		{"MEDIA_MAX_BYTES", c.MediaMaxBytes},
		{"MEDIA_CONCURRENCY", int64(c.MediaConcurrency)},
		{"MEDIA_MAX_ATTEMPTS", int64(c.MediaMaxAttempts)},
		{"HISTORY_SYNC_MAX_DAYS", int64(c.HistorySyncMaxDays)},
		{"SEND_MAX_ATTEMPTS", int64(c.SendMaxAttempts)},
		{"MEMORY_BATCH_CONCURRENCY", int64(c.MemoryBatchConcurrency)},
	} {
		if v.value <= 0 {
			return fmt.Errorf("%s must be positive, got %d", v.key, v.value)
		}
	}
	if err := c.validateMemoryCallback(); err != nil {
		return err
	}
	if err := c.validateOwnerReply(); err != nil {
		return err
	}
	return nil
}

func (c *Config) validateMemoryCallback() error {
	configured := 0
	for _, value := range []string{c.MemoryCallbackURL, c.MemoryCallbackSecret} {
		if value != "" {
			configured++
		}
	}
	if configured == 0 {
		return nil
	}
	if configured != 2 {
		return errors.New("MEMORY_CALLBACK_URL and MEMORY_CALLBACK_SECRET must be configured together")
	}
	callback, err := url.ParseRequestURI(c.MemoryCallbackURL)
	if err != nil || callback.Host == "" || (callback.Scheme != "http" && callback.Scheme != "https") {
		return fmt.Errorf("MEMORY_CALLBACK_URL must be an absolute HTTP(S) URL, got %q", c.MemoryCallbackURL)
	}
	return nil
}

// validateOwnerReply gates owner-mention delivery.
//
// The callback pair is what actually delivers a mention: `deliverSavedReplies`
// posts to `REPLY_CALLBACK_URL` and returns immediately when it is empty, so
// those two are required together and nothing else is.
//
// Who counts as an owner is deliberately not decided here. The BFF authorizes
// the sender of a mention against the `organizations` document it owns — the
// same list the dashboard's owner editor writes — so `OWNER_WHATSAPP_JID` is
// optional: normalized when the deployment sets it, ignored when it does not.
func (c *Config) validateOwnerReply() error {
	if (c.ReplyCallbackURL == "") != (c.ReplyCallbackSecret == "") {
		return errors.New("REPLY_CALLBACK_URL and REPLY_CALLBACK_SECRET must be configured together")
	}
	if c.OwnerWhatsAppJID != "" {
		owner := ownerPhoneDigits(c.OwnerWhatsAppJID, c.DefaultCountryCode)
		if owner == "" {
			return fmt.Errorf("OWNER_WHATSAPP_JID must be a WhatsApp user JID, got %q", c.OwnerWhatsAppJID)
		}
		c.OwnerWhatsAppJID = types.NewJID(owner, types.DefaultUserServer).String()
	}
	if c.ReplyCallbackURL == "" {
		return nil
	}

	callback, err := url.ParseRequestURI(c.ReplyCallbackURL)
	if err != nil || callback.Host == "" || (callback.Scheme != "http" && callback.Scheme != "https") {
		return fmt.Errorf("REPLY_CALLBACK_URL must be an absolute HTTP(S) URL, got %q", c.ReplyCallbackURL)
	}
	return nil
}

// ownerPhoneDigits reduces an operator-written owner number to the bare E.164
// digits the reply gate compares, mirroring the BFF's normalizeAuthorizedJid
// (apps/web/src/server/authorized-jids.ts) so the two sides agree on whose
// message it is. An operator writes their own number the way their phone shows
// it — national form, `0899…` — so a leading zero run is replaced with the
// deployment country code; a leading `00` is the other way people write
// international, so those two digits are dropped instead. A value naming
// anything but a user server (a group JID, say) is not a phone number, and
// neither is anything outside E.164's 7..15 digits; both yield "".
func ownerPhoneDigits(value, countryCode string) string {
	user := strings.TrimSpace(value)
	if i := strings.IndexByte(user, '@'); i >= 0 {
		if server := user[i+1:]; server != types.DefaultUserServer && server != types.LegacyUserServer {
			return ""
		}
		user = user[:i]
	}
	// A device suffix (`:12`, or the `user.agent:device` spelling) identifies a
	// session, not a different account.
	if i := strings.IndexAny(user, ".:"); i >= 0 {
		user = user[:i]
	}

	digits := digitsOnly(user)
	switch {
	case strings.HasPrefix(digits, "00"):
		digits = digits[2:]
	case strings.HasPrefix(digits, "0"):
		digits = usableCountryCode(countryCode) + strings.TrimLeft(digits, "0")
	}
	// `^[1-9][0-9]{6,14}$`, on a string that is already all digits.
	if len(digits) < 7 || len(digits) > 15 || digits[0] == '0' {
		return ""
	}
	return digits
}

// usableCountryCode is the dialling code a national-form number is expanded
// with: DEFAULT_COUNTRY_CODE when it reads as 1..4 digits with no leading zero,
// else the fallback. A typo in the environment must not turn every national
// number the operator enters into a rejected one.
func usableCountryCode(configured string) string {
	code := digitsOnly(configured)
	if len(code) == 0 || len(code) > 4 || code[0] == '0' {
		return fallbackCountryCode
	}
	return code
}

// digitsOnly drops everything that is not an ASCII digit, the way `+62
// 899-6926-184` is read as the number it spells.
func digitsOnly(s string) string {
	return strings.Map(func(r rune) rune {
		if r < '0' || r > '9' {
			return -1
		}
		return r
	}, s)
}

// env returns the variable, falling back to def when it is unset or empty.
func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envInt reads an integer variable; an unset, empty, or unparsable value yields
// def (integers carry no unit, so a wrong value cannot change a timeout's unit).
func envInt(key string, def int) int {
	n, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return def
	}
	return n
}

func envBool(key string, def bool) bool {
	b, err := strconv.ParseBool(os.Getenv(key))
	if err != nil {
		return def
	}
	return b
}

// envDuration reads a duration variable such as `45s` or `30m`.
func envDuration(key string, def time.Duration) (time.Duration, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}
	return d, nil
}
