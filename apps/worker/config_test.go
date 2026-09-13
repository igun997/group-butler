package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestLoadConfig_LocalDefaults(t *testing.T) {
	// setDevEnv pins every variable loadConfig reads, so no ambient PORT,
	// ORGANIZATION_ID, GROUP_SYNC_PRUNE, or knob can shift these defaults.
	setDevEnv(t)

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.Port != "4000" {
		t.Errorf("Port = %q, want 4000", cfg.Port)
	}
	if cfg.OrganizationID != "org_default" {
		t.Errorf("OrganizationID = %q, want org_default", cfg.OrganizationID)
	}
	if cfg.GroupSyncInterval != 30*time.Minute {
		t.Errorf("GroupSyncInterval = %v, want 30m", cfg.GroupSyncInterval)
	}
	if cfg.MediaDownloadTimeout != 45*time.Second {
		t.Errorf("MediaDownloadTimeout = %v, want 45s", cfg.MediaDownloadTimeout)
	}
	if !cfg.GroupSyncPrune {
		t.Error("GroupSyncPrune = false, want true by default")
	}
}

func TestLoadConfig_DevWhatsmeowDBMatchesEnvExample(t *testing.T) {
	// The unset fallback is the value the dev launcher sources from the root
	// `.env.example`, i.e. a relative path inside the git-ignored
	// apps/worker/.localdata/ — never the container's mounted /data path, which
	// a host process may not even be able to create.
	setDevEnv(t)
	t.Setenv("WHATSMEOW_DB_URI", "")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if want := envExampleValue(t, "WHATSMEOW_DB_URI"); cfg.WhatsmeowDB != want {
		t.Errorf("WhatsmeowDB = %q, want %q from .env.example", cfg.WhatsmeowDB, want)
	}
}

// setDevEnv pins every variable loadConfig reads to a documentedly valid
// development value, so a test can never be perturbed by what the developer's
// shell happens to export (PORT, ORGANIZATION_ID, GROUP_SYNC_PRUNE, any knob).
func setDevEnv(t *testing.T) {
	t.Helper()
	t.Setenv("ENVIRONMENT", developmentEnv)
	t.Setenv("MONGODB_URI", devMongoURI)
	t.Setenv("WORKER_SECRET", devWorkerSecret)
	for _, key := range []string{
		"PORT",
		"ORGANIZATION_ID",
		"MONGODB_DB",
		"WHATSMEOW_DB_URI",
		"LOG_LEVEL",
		"R2_ACCOUNT_ID",
		"R2_ACCESS_KEY_ID",
		"R2_SECRET_ACCESS_KEY",
		"R2_BUCKET",
		"R2_PUBLIC_URL",
		"AI_BASE_URL",
		"AI_API_KEY",
		"AI_MODEL",
		"INGEST_QUEUE_SIZE",
		"INGEST_FLUSH_MS",
		"INGEST_FLUSH_MAX",
		"RAW_JSON_MAX_BYTES",
		"RAW_SEARCH_MAX_BYTES",
		"MEDIA_MAX_BYTES",
		"MEDIA_CONCURRENCY",
		"MEDIA_DOWNLOAD_TIMEOUT",
		"MEDIA_MAX_ATTEMPTS",
		"MEDIA_JANITOR_INTERVAL",
		"MEDIA_ENRICH_ENABLED",
		"HISTORY_SYNC_MAX_DAYS",
		"GROUP_SYNC_INTERVAL",
		"GROUP_STALE_AFTER",
		"GROUP_SYNC_PRUNE",
		"DISPATCH_INTERVAL",
		"SEND_MAX_ATTEMPTS",
	} {
		t.Setenv(key, "")
	}
}

func TestLoadConfig_ProductionWhatsmeowDB(t *testing.T) {
	const prodSecret = "production-secret-from-the-secret-store"

	t.Run("rejects an unset WHATSMEOW_DB_URI", func(t *testing.T) {
		setDevEnv(t)
		t.Setenv("ENVIRONMENT", productionEnv)
		t.Setenv("WORKER_SECRET", prodSecret)

		if _, err := loadConfig(); err == nil {
			t.Fatal("loadConfig fell back to the development auth store in production")
		}
	})

	t.Run("accepts the declared mounted auth path", func(t *testing.T) {
		setDevEnv(t)
		t.Setenv("ENVIRONMENT", productionEnv)
		t.Setenv("WORKER_SECRET", prodSecret)
		t.Setenv("WHATSMEOW_DB_URI", "file:/data/whatsmeow.db?_foreign_keys=on")

		cfg, err := loadConfig()
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if cfg.WhatsmeowDB != "file:/data/whatsmeow.db?_foreign_keys=on" {
			t.Errorf("WhatsmeowDB = %q", cfg.WhatsmeowDB)
		}
	})
}

func TestLoadConfig_RejectsNonPositiveLimits(t *testing.T) {
	// Every operational count, limit, and interval is positive-only: an empty
	// queue, a zero cap or concurrency, no attempt budget, or a zero interval
	// either stores nothing or never makes progress (time.NewTicker panics on a
	// non-positive interval). Booleans and PORT are deliberately absent.
	for _, tc := range []struct{ key, value string }{
		{"INGEST_QUEUE_SIZE", "0"},
		{"INGEST_FLUSH_MS", "0"},
		{"INGEST_FLUSH_MAX", "0"},
		{"RAW_JSON_MAX_BYTES", "0"},
		{"RAW_SEARCH_MAX_BYTES", "0"},
		{"MEDIA_MAX_BYTES", "0"},
		{"MEDIA_CONCURRENCY", "0"},
		{"MEDIA_DOWNLOAD_TIMEOUT", "0"},
		{"MEDIA_MAX_ATTEMPTS", "0"},
		{"MEDIA_JANITOR_INTERVAL", "0"},
		{"HISTORY_SYNC_MAX_DAYS", "0"},
		{"GROUP_SYNC_INTERVAL", "0"},
		{"GROUP_STALE_AFTER", "0"},
		{"DISPATCH_INTERVAL", "0"},
		{"SEND_MAX_ATTEMPTS", "0"},
		// One representative below the boundary, so the gate is proven to be
		// `<= 0` and not merely "rejects the zero the table above supplies".
		{"INGEST_QUEUE_SIZE", "-1"},
	} {
		t.Run(tc.key+"="+tc.value, func(t *testing.T) {
			setDevEnv(t)
			t.Setenv(tc.key, tc.value)

			if _, err := loadConfig(); err == nil {
				t.Fatalf("loadConfig accepted %s=%s", tc.key, tc.value)
			}
		})
	}
}

func TestLoadConfig_NonPositiveDurationErrorIsOperatorReadable(t *testing.T) {
	// A rejected interval must name the variable and print the duration the way
	// it was configured, not as raw nanoseconds.
	setDevEnv(t)
	t.Setenv("MEDIA_JANITOR_INTERVAL", "-1s")

	_, err := loadConfig()
	if err == nil {
		t.Fatal("loadConfig accepted MEDIA_JANITOR_INTERVAL=-1s")
	}
	if !strings.Contains(err.Error(), "MEDIA_JANITOR_INTERVAL") || !strings.Contains(err.Error(), "-1s") {
		t.Errorf("error = %q, want the variable name and the duration", err)
	}
}

// envExampleValue reads KEY's value out of the root `.env.example`, the single
// source the dev launcher sources and therefore the definition of every local
// default. Values there are bare, space-free shell tokens, so a space ends the
// value and starts a trailing comment.
func envExampleValue(t *testing.T, key string) string {
	t.Helper()
	raw, err := os.ReadFile("../../.env.example")
	if err != nil {
		t.Fatalf("read root .env.example: %v", err)
	}
	prefix := key + "="
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, prefix) {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(line, prefix))
		if i := strings.IndexByte(value, ' '); i >= 0 {
			value = value[:i]
		}
		return value
	}
	t.Fatalf(".env.example has no %s entry", key)
	return ""
}

func TestLoadConfig_ProductionRequiresSecrets(t *testing.T) {
	setDevEnv(t)
	t.Setenv("ENVIRONMENT", "production")
	t.Setenv("MONGODB_URI", "mongodb://example/group_butler")
	t.Setenv("WORKER_SECRET", "dev-secret") // the insecure default
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig succeeded with the dev WORKER_SECRET in production")
	}
}

func TestLoadConfig_RejectsBadDuration(t *testing.T) {
	setDevEnv(t)
	t.Setenv("GROUP_SYNC_INTERVAL", "not-a-duration")
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig accepted a malformed GROUP_SYNC_INTERVAL")
	}
}
