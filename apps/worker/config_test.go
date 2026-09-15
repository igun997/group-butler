package main

import (
	"os"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
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
		"DEFAULT_COUNTRY_CODE",
		"OWNER_WHATSAPP_JID",
		"REPLY_CALLBACK_URL",
		"REPLY_CALLBACK_SECRET",
		"INGEST_QUEUE_SIZE",
		"INGEST_FLUSH_MS",
		"INGEST_FLUSH_MAX",
		"EVENT_QUEUE_SIZE",
		"EVENT_WORKERS",
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
		"MEMORY_CALLBACK_URL",
		"MEMORY_CALLBACK_SECRET",
		"MEMORY_BATCH_INTERVAL",
		"MEMORY_BATCH_CONCURRENCY",
	} {
		t.Setenv(key, "")
	}
}

func TestLoadConfigRequiresCompleteMemoryCallbackCredentials(t *testing.T) {
	setDevEnv(t)
	t.Setenv("MEMORY_CALLBACK_URL", "http://127.0.0.1:3000/api/internal/memory-batches")
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig accepted a memory callback URL without its bearer secret")
	}

	setDevEnv(t)
	t.Setenv("MEMORY_CALLBACK_SECRET", "test-secret")
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig accepted a memory callback secret without its URL")
	}

	setDevEnv(t)
	t.Setenv("MEMORY_CALLBACK_URL", "https://memory.example.test/batches")
	t.Setenv("MEMORY_CALLBACK_SECRET", "test-secret")
	if _, err := loadConfig(); err != nil {
		t.Fatalf("loadConfig rejected complete memory callback credentials: %v", err)
	}
}

func TestLoadConfigProductionRejectsDevelopmentMemoryCallbackSecret(t *testing.T) {
	setDevEnv(t)
	t.Setenv("ENVIRONMENT", productionEnv)
	t.Setenv("WORKER_SECRET", "production-secret-from-the-secret-store")
	t.Setenv("WHATSMEOW_DB_URI", "file:/data/whatsmeow.db?_foreign_keys=on")
	t.Setenv("MEMORY_CALLBACK_URL", "https://memory.example.test/batches")
	t.Setenv("MEMORY_CALLBACK_SECRET", devMemoryCallbackSecret)
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig accepted the documented development memory callback secret in production")
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

// TestLoadConfigBindsRawCapsToParser is the wiring proof: loadConfig is the only
// configuration boundary the worker has, so a successful call must leave the
// parser applying exactly the configured raw-tree caps — not the built-in
// defaults, which is what an unwired loadConfig leaves behind.
func TestLoadConfigBindsRawCapsToParser(t *testing.T) {
	restoreJSON, restoreSearch := rawJSONMaxBytes, rawSearchMaxBytes
	t.Cleanup(func() { rawJSONMaxBytes, rawSearchMaxBytes = restoreJSON, restoreSearch })

	setDevEnv(t)
	t.Setenv("RAW_JSON_MAX_BYTES", "4096")
	t.Setenv("RAW_SEARCH_MAX_BYTES", "64")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.RawJSONMaxBytes != 4096 || cfg.RawSearchMax != 64 {
		t.Fatalf("config = %d/%d, want the values from the environment", cfg.RawJSONMaxBytes, cfg.RawSearchMax)
	}
	if rawJSONMaxBytes != cfg.RawJSONMaxBytes || rawSearchMaxBytes != cfg.RawSearchMax {
		t.Fatalf("parser caps = %d/%d, want the configured %d/%d",
			rawJSONMaxBytes, rawSearchMaxBytes, cfg.RawJSONMaxBytes, cfg.RawSearchMax)
	}

	// The same caps must reach the parse itself, not just the variables.
	msg := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Caption:       proto.String("quarterly chart"),
		Mimetype:      proto.String("image/jpeg"),
		JPEGThumbnail: make([]byte, 4096),
	}}
	doc, err := parseInbound(
		evtMessage(types.NewJID("120363043123456789", types.GroupServer), types.NewJID("628990000001", types.DefaultUserServer), "3EB0E1", msg),
		"org_default", "inst_1",
	)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if !doc.Raw.Truncated || len(doc.RawSearch) > 64 {
		t.Errorf("raw truncated=%v (%d bytes), rawSearch=%d bytes, want the configured caps applied",
			doc.Raw.Truncated, doc.Raw.Bytes, len(doc.RawSearch))
	}
}

// TestLoadConfigLeavesRawCapsUntouchedWhenItRejects guards the other half of the
// boundary: a configuration the worker refuses to run with must not become the
// parser's limits. The caps start at sentinels no environment value can produce.
func TestLoadConfigLeavesRawCapsUntouchedWhenItRejects(t *testing.T) {
	const sentinelJSON, sentinelSearch = 1111, 2222
	restoreJSON, restoreSearch := rawJSONMaxBytes, rawSearchMaxBytes
	t.Cleanup(func() { rawJSONMaxBytes, rawSearchMaxBytes = restoreJSON, restoreSearch })

	assertSentinels := func(t *testing.T) {
		t.Helper()
		if rawJSONMaxBytes != sentinelJSON || rawSearchMaxBytes != sentinelSearch {
			t.Errorf("parser caps = %d/%d, want the untouched sentinels %d/%d",
				rawJSONMaxBytes, rawSearchMaxBytes, sentinelJSON, sentinelSearch)
		}
	}

	t.Run("rejected validation", func(t *testing.T) {
		rawJSONMaxBytes, rawSearchMaxBytes = sentinelJSON, sentinelSearch
		setDevEnv(t)
		t.Setenv("RAW_SEARCH_MAX_BYTES", "0") // non-positive: validate rejects it

		if _, err := loadConfig(); err == nil {
			t.Fatal("loadConfig accepted RAW_SEARCH_MAX_BYTES=0")
		}
		assertSentinels(t)
	})

	t.Run("rejected production gate", func(t *testing.T) {
		rawJSONMaxBytes, rawSearchMaxBytes = sentinelJSON, sentinelSearch
		setDevEnv(t)
		t.Setenv("ENVIRONMENT", productionEnv)
		t.Setenv("WORKER_SECRET", devWorkerSecret) // the gate rejects this
		t.Setenv("RAW_JSON_MAX_BYTES", "4096")     // valid, but must stay unapplied

		if _, err := loadConfig(); err == nil {
			t.Fatal("loadConfig succeeded with the dev WORKER_SECRET in production")
		}
		assertSentinels(t)
	})
}

// The owner identity does not gate delivery: the BFF authorizes the sender of a
// mention against the list it owns in Mongo, so an identity on its own must not
// stop the worker from starting.
func TestLoadConfig_AcceptsOwnerIdentityWithoutCallbackCredentials(t *testing.T) {
	setDevEnv(t)
	t.Setenv("OWNER_WHATSAPP_JID", "628990000001@s.whatsapp.net")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.OwnerWhatsAppJID != "628990000001@s.whatsapp.net" {
		t.Errorf("OwnerWhatsAppJID = %q, want the canonical JID", cfg.OwnerWhatsAppJID)
	}
	if cfg.ReplyCallbackURL != "" {
		t.Errorf("ReplyCallbackURL = %q, want it unset", cfg.ReplyCallbackURL)
	}
}

// The callback pair is the delivery switch, so half of it is a misconfiguration
// rather than a partial feature.
func TestLoadConfig_RejectsHalfATooCallbackPair(t *testing.T) {
	for _, tt := range []struct {
		name   string
		setURL bool
	}{
		{"url without secret", true},
		{"secret without url", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			setDevEnv(t)
			if tt.setURL {
				t.Setenv("REPLY_CALLBACK_URL", "http://127.0.0.1:3000/api/internal/reply-jobs")
			} else {
				t.Setenv("REPLY_CALLBACK_SECRET", "reply-callback-secret")
			}

			_, err := loadConfig()
			if err == nil {
				t.Fatal("loadConfig accepted half a reply callback pair")
			}
			if want := "REPLY_CALLBACK_URL and REPLY_CALLBACK_SECRET must be configured together"; !strings.Contains(err.Error(), want) {
				t.Errorf("error = %q, want it to contain %q", err, want)
			}
		})
	}
}

func TestLoadConfig_LoadsOwnerReplyConfiguration(t *testing.T) {
	setDevEnv(t)
	t.Setenv("OWNER_WHATSAPP_JID", "628990000001:5@s.whatsapp.net")
	t.Setenv("REPLY_CALLBACK_URL", "http://127.0.0.1:3000/api/internal/reply-jobs")
	t.Setenv("REPLY_CALLBACK_SECRET", "reply-callback-secret")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.OwnerWhatsAppJID != "628990000001@s.whatsapp.net" {
		t.Errorf("OwnerWhatsAppJID = %q, want canonical phone JID", cfg.OwnerWhatsAppJID)
	}
	if cfg.ReplyCallbackURL != "http://127.0.0.1:3000/api/internal/reply-jobs" {
		t.Errorf("ReplyCallbackURL = %q", cfg.ReplyCallbackURL)
	}
}

// TestLoadConfig_NormalizesOwnerPhoneSpellings pins the worker to the BFF's
// normalization (apps/web/src/server/authorized-jids.ts). The reply gate
// compares JIDs, so a number the operator can enter in the dashboard must
// survive the worker's startup validation as the same canonical JID.
func TestLoadConfig_NormalizesOwnerPhoneSpellings(t *testing.T) {
	for _, tt := range []struct {
		name        string
		countryCode string
		configured  string
		want        string
	}{
		{"national form takes the deployment country code", "", "08996926184", "628996926184@s.whatsapp.net"},
		{"international form is already canonical", "", "628996926184", "628996926184@s.whatsapp.net"},
		{"punctuation and spacing are not part of the number", "", "+62 899-6926-184", "628996926184@s.whatsapp.net"},
		{"the 00 prefix is the other way to write international", "", "00628996926184", "628996926184@s.whatsapp.net"},
		{"a device JID reduces to the same account", "", "628996926184:12@s.whatsapp.net", "628996926184@s.whatsapp.net"},
		{"the legacy user server names the same account", "", "628996926184@c.us", "628996926184@s.whatsapp.net"},
		{"the configured country code expands the national form", "44", "08996926184", "448996926184@s.whatsapp.net"},
		{"an unusable country code falls back to the deployment default", "not-a-code", "08996926184", "628996926184@s.whatsapp.net"},
		{"a country code is read as digits, not as written", " 62 ", "08996926184", "628996926184@s.whatsapp.net"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			setDevEnv(t)
			t.Setenv("DEFAULT_COUNTRY_CODE", tt.countryCode)
			t.Setenv("OWNER_WHATSAPP_JID", tt.configured)
			t.Setenv("REPLY_CALLBACK_URL", "http://127.0.0.1:3000/api/internal/reply-jobs")
			t.Setenv("REPLY_CALLBACK_SECRET", "reply-callback-secret")

			cfg, err := loadConfig()
			if err != nil {
				t.Fatalf("loadConfig(OWNER_WHATSAPP_JID=%q, DEFAULT_COUNTRY_CODE=%q): %v", tt.configured, tt.countryCode, err)
			}
			if cfg.OwnerWhatsAppJID != tt.want {
				t.Errorf("OwnerWhatsAppJID = %q, want %q", cfg.OwnerWhatsAppJID, tt.want)
			}
		})
	}
}

// TestLoadConfig_RejectsUnusableOwnerPhoneValues keeps the loud failure for
// values that cannot be the owner's phone — the same set the BFF refuses. A
// typo must stop the worker instead of silently disabling replies, and the
// message must keep naming the setting.
func TestLoadConfig_RejectsUnusableOwnerPhoneValues(t *testing.T) {
	for _, configured := range []string{
		"0",
		"12",
		"0899",
		"abc",
		"62 899 626 184 99 88 77 66 55", // longer than E.164 allows
		"@s.whatsapp.net",
		"120363043123456@g.us", // a group id is not a phone number
	} {
		t.Run(configured, func(t *testing.T) {
			setDevEnv(t)
			t.Setenv("OWNER_WHATSAPP_JID", configured)
			t.Setenv("REPLY_CALLBACK_URL", "http://127.0.0.1:3000/api/internal/reply-jobs")
			t.Setenv("REPLY_CALLBACK_SECRET", "reply-callback-secret")

			_, err := loadConfig()
			if err == nil {
				t.Fatalf("loadConfig accepted OWNER_WHATSAPP_JID=%q", configured)
			}
			if want := "OWNER_WHATSAPP_JID must be a WhatsApp user JID"; !strings.Contains(err.Error(), want) {
				t.Errorf("error = %q, want it to contain %q", err, want)
			}
		})
	}
}
