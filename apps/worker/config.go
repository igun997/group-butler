package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

const (
	developmentEnv = "development"
	productionEnv  = "production"

	// devWorkerSecret is the local placeholder from `.env.example`. Production
	// refuses to boot while WORKER_SECRET is missing or still this value.
	devWorkerSecret = "dev-secret"

	devMongoURI = "mongodb://127.0.0.1:27017/group_butler?replicaSet=rs0"

	// devWhatsmeowURI mirrors the value root `.env.example` supplies, so the
	// fallback stays inside the git-ignored apps/worker/.localdata/. Deployment
	// sets the mounted-volume path explicitly (apps/worker/.env.production.example).
	devWhatsmeowURI = "file:./.localdata/whatsmeow.db?_foreign_keys=on"
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
	R2Endpoint     string
	R2AccessKeyID  string
	R2SecretKey    string
	R2Bucket       string
	R2PublicURL    string

	IngestQueueSize int
	IngestFlush     time.Duration
	IngestFlushMax  int
	RawJSONMaxBytes int
	RawSearchMax    int

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
		R2Endpoint:    r2Endpoint(os.Getenv("R2_ACCOUNT_ID")),
		R2AccessKeyID: os.Getenv("R2_ACCESS_KEY_ID"),
		R2SecretKey:   os.Getenv("R2_SECRET_ACCESS_KEY"),
		R2Bucket:      os.Getenv("R2_BUCKET"),
		R2PublicURL:   os.Getenv("R2_PUBLIC_URL"),

		IngestQueueSize: envInt("INGEST_QUEUE_SIZE", 512),
		IngestFlush:     time.Duration(envInt("INGEST_FLUSH_MS", 250)) * time.Millisecond,
		IngestFlushMax:  envInt("INGEST_FLUSH_MAX", 100),
		RawJSONMaxBytes: envInt("RAW_JSON_MAX_BYTES", 32768),
		RawSearchMax:    envInt("RAW_SEARCH_MAX_BYTES", 8192),

		MediaMaxBytes:      int64(envInt("MEDIA_MAX_BYTES", 25*1024*1024)),
		MediaConcurrency:   envInt("MEDIA_CONCURRENCY", 4),
		MediaMaxAttempts:   envInt("MEDIA_MAX_ATTEMPTS", 3),
		MediaEnrichEnabled: envBool("MEDIA_ENRICH_ENABLED", false),

		GroupSyncPrune:     envBool("GROUP_SYNC_PRUNE", true),
		SendMaxAttempts:    envInt("SEND_MAX_ATTEMPTS", 3),
		HistorySyncMaxDays: envInt("HISTORY_SYNC_MAX_DAYS", 30),

		AIBaseURL: os.Getenv("AI_BASE_URL"),
		AIAPIKey:  os.Getenv("AI_API_KEY"),
		AIModel:   os.Getenv("AI_MODEL"),

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
	}

	return cfg, nil
}

// validate rejects configurations the worker could not run with. Every count,
// cap, and interval is positive-only: an empty queue or a zero cap stores
// nothing, a zero concurrency or attempt budget can never finish, and a zero
// interval either spins a loop or panics time.NewTicker. PORT is excluded (a
// blank port falls back to the documented one) and so are the booleans.
func (c Config) validate() error {
	for _, v := range []struct {
		key   string
		value int64
	}{
		{"INGEST_QUEUE_SIZE", int64(c.IngestQueueSize)},
		{"INGEST_FLUSH_MS", int64(c.IngestFlush / time.Millisecond)},
		{"INGEST_FLUSH_MAX", int64(c.IngestFlushMax)},
		{"RAW_JSON_MAX_BYTES", int64(c.RawJSONMaxBytes)},
		{"RAW_SEARCH_MAX_BYTES", int64(c.RawSearchMax)},
		{"MEDIA_MAX_BYTES", c.MediaMaxBytes},
		{"MEDIA_CONCURRENCY", int64(c.MediaConcurrency)},
		{"MEDIA_DOWNLOAD_TIMEOUT", int64(c.MediaDownloadTimeout)},
		{"MEDIA_MAX_ATTEMPTS", int64(c.MediaMaxAttempts)},
		{"MEDIA_JANITOR_INTERVAL", int64(c.MediaJanitorEvery)},
		{"HISTORY_SYNC_MAX_DAYS", int64(c.HistorySyncMaxDays)},
		{"GROUP_SYNC_INTERVAL", int64(c.GroupSyncInterval)},
		{"GROUP_STALE_AFTER", int64(c.GroupStaleAfter)},
		{"DISPATCH_INTERVAL", int64(c.DispatchInterval)},
		{"SEND_MAX_ATTEMPTS", int64(c.SendMaxAttempts)},
	} {
		if v.value <= 0 {
			return fmt.Errorf("%s must be positive, got %d", v.key, v.value)
		}
	}
	return nil
}

// r2Endpoint derives the account-scoped endpoint. The endpoint is derived here,
// not configured: there is no emulator and no override anywhere in the project.
func r2Endpoint(accountID string) string {
	if accountID == "" {
		return ""
	}
	return "https://" + accountID + ".r2.cloudflarestorage.com"
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
