package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestLoadConfig_LocalDefaults(t *testing.T) {
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("MONGODB_URI", "mongodb://127.0.0.1:27017/group_butler?replicaSet=rs0")
	t.Setenv("WORKER_SECRET", "dev-secret")
	t.Setenv("GROUP_SYNC_INTERVAL", "")
	t.Setenv("MEDIA_DOWNLOAD_TIMEOUT", "")

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
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("WHATSMEOW_DB_URI", "")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if want := envExampleValue(t, "WHATSMEOW_DB_URI"); cfg.WhatsmeowDB != want {
		t.Errorf("WhatsmeowDB = %q, want %q from .env.example", cfg.WhatsmeowDB, want)
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
	t.Setenv("ENVIRONMENT", "production")
	t.Setenv("MONGODB_URI", "mongodb://example/group_butler")
	t.Setenv("WORKER_SECRET", "dev-secret") // the insecure default
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig succeeded with the dev WORKER_SECRET in production")
	}
}

func TestLoadConfig_RejectsBadDuration(t *testing.T) {
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("MONGODB_URI", "mongodb://127.0.0.1:27017/group_butler")
	t.Setenv("WORKER_SECRET", "dev-secret")
	t.Setenv("GROUP_SYNC_INTERVAL", "not-a-duration")
	if _, err := loadConfig(); err == nil {
		t.Fatal("loadConfig accepted a malformed GROUP_SYNC_INTERVAL")
	}
}
