package main

import (
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
