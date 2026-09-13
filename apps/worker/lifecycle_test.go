package main

import (
	"testing"

	"go.mau.fi/whatsmeow/types"
)

func TestPhoneDigitsFromJIDStripsDeviceSuffix(t *testing.T) {
	if got := phoneDigitsFromJID(types.NewJID("628990000001", types.DefaultUserServer)); got != "628990000001" {
		t.Errorf("phoneDigitsFromJID = %q", got)
	}
	if got := phoneDigitsFromJID(types.NewJID("628990000001:12", types.DefaultUserServer)); got != "628990000001" {
		t.Errorf("device suffix not stripped: %q", got)
	}
	if got := phoneDigitsFromJID(types.NewJID("120363043123456789", types.GroupServer)); got != "" {
		t.Errorf("group JID must not yield a phone number: %q", got)
	}
}

func TestDeviceOwnedByOtherRejectsSecondLiveSession(t *testing.T) {
	first := types.NewJID("628990000001", types.DefaultUserServer)
	second := types.NewJID("628990000002", types.DefaultUserServer)
	live := map[string]types.JID{"inst_1": first}

	if !deviceOwnedByOther(live, "inst_2", first) {
		t.Error("a device owned by another live session must be rejected")
	}
	if deviceOwnedByOther(live, "inst_2", second) {
		t.Error("a different device must be accepted")
	}
	if deviceOwnedByOther(live, "inst_1", first) {
		t.Error("a session must not conflict with itself")
	}
}

func TestRestorableInstancesNeverFallsBackToAnotherDevice(t *testing.T) {
	rows := []InstanceRow{
		{ID: "inst_1", PhoneNumber: "628990000001", Status: "connected"},
		{ID: "inst_2", PhoneNumber: "", Status: "pairing"},
		{ID: "inst_3", PhoneNumber: "628990000003", Status: "logged_out"},
		{ID: "inst_4", PhoneNumber: "628990000004", Status: "connected"},
	}
	devices := map[string]bool{"628990000001": true}

	got := restorableInstances(rows, func(phone string) bool { return devices[phone] })
	if len(got) != 1 || got[0] != "inst_1" {
		t.Fatalf("restorable = %v, want [inst_1]", got)
	}
}
