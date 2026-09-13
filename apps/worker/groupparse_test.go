package main

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// parseNotification runs the REAL whatsmeow parser over a fixture node.
// whatsmeow.NewClient(nil, …) is safe for parsing: NewClient initialises
// groupCache and only nil-checks the device store on network paths
// (client.go:240-270), and DangerousInternals() exposes parseGroupNotification
// (internals.go:270).
func parseNotification(t *testing.T, node waBinary.Node) any {
	t.Helper()
	cli := whatsmeow.NewClient(nil, waLog.Noop)
	evt, _, _, err := cli.DangerousInternals().ParseGroupNotification(nodePtr(t, node))
	if err != nil {
		t.Fatalf("ParseGroupNotification: %v", err)
	}
	return evt
}

func TestParseGroupNotification_SubjectRename(t *testing.T) {
	node := renameNotificationNode()
	assertFixtureFidelity(t, "group_rename.xml", node)

	evt, ok := parseNotification(t, node).(*events.GroupInfo)
	if !ok {
		t.Fatal("expected *events.GroupInfo")
	}
	if evt.JID.String() != testGroupJID.String() {
		t.Errorf("JID = %s, want %s", evt.JID, testGroupJID)
	}
	if evt.Name == nil {
		t.Fatal("Name is nil: the real parser did not surface the subject change")
	}
	if evt.Name.Name != "Ops Team" {
		t.Errorf("Name.Name = %q, want Ops Team", evt.Name.Name)
	}
	if !evt.Name.NameSetAt.Equal(testRenameAt) {
		t.Errorf("NameSetAt = %v, want %v", evt.Name.NameSetAt, testRenameAt)
	}
	if evt.Name.NameSetBy.String() != testAdminPN.String() {
		t.Errorf("NameSetBy = %s, want %s", evt.Name.NameSetBy, testAdminPN)
	}
}

func TestParseGroupNotification_Create(t *testing.T) {
	node := createNotificationNode()
	assertFixtureFidelity(t, "group_create.xml", node)

	evtAny := parseNotification(t, node)
	joined, ok := evtAny.(*events.JoinedGroup)
	if !ok {
		t.Fatalf("expected *events.JoinedGroup for a <create> notification, got %T", evtAny)
	}
	if joined.GroupInfo.JID.String() != testOtherGroup.String() {
		t.Errorf("JID = %s, want %s", joined.GroupInfo.JID, testOtherGroup)
	}
	if joined.GroupInfo.Name != "New Crew" {
		t.Errorf("Name = %q, want New Crew", joined.GroupInfo.Name)
	}
	if joined.Type != "new" {
		t.Errorf("Type = %q, want new", joined.Type)
	}
}

func TestParseGroupChange_Delete(t *testing.T) {
	evt, ok := parseNotification(t, deleteNotificationNode()).(*events.GroupInfo)
	if !ok {
		t.Fatal("expected *events.GroupInfo")
	}
	if evt.Delete == nil || !evt.Delete.Deleted || evt.Delete.DeleteReason != "user_left" {
		t.Fatalf("Delete = %+v, want Deleted=true reason=user_left", evt.Delete)
	}
}

func TestParseGroupChange_SelfRemoved(t *testing.T) {
	evt, ok := parseNotification(t, selfRemovalNotificationNode()).(*events.GroupInfo)
	if !ok {
		t.Fatal("expected *events.GroupInfo")
	}
	for _, jid := range evt.Leave {
		if jid.String() == testSelfPN.String() {
			return
		}
	}
	t.Fatalf("Leave = %v, want it to contain %s (participant@jid must be a types.JID)", evt.Leave, testSelfPN)
}

func TestParseGroupChange_UnknownChild(t *testing.T) {
	evt, ok := parseNotification(t, unknownChildNotificationNode()).(*events.GroupInfo)
	if !ok {
		t.Fatal("expected *events.GroupInfo: an unknown child must not drop the event")
	}
	if len(evt.UnknownChanges) != 1 || evt.UnknownChanges[0].Tag != "future_feature" {
		t.Fatalf("UnknownChanges = %v, want one future_feature entry", evt.UnknownChanges)
	}
}

// TestParseGroupSyncResponse drives the same parser GetJoinedGroups uses on the
// membership snapshot, so the sync path is proven against real wire shapes
// rather than against a hand-written struct literal (§14.1).
func TestParseGroupSyncResponse(t *testing.T) {
	groups := syncGroupsNode()
	assertFixtureFidelity(t, "group_sync_response.xml", groups)

	children := groups.GetChildren()
	if len(children) != 1 {
		t.Fatalf("fixture carries %d groups, want 1", len(children))
	}
	cli := whatsmeow.NewClient(nil, waLog.Noop)
	info, err := cli.DangerousInternals().ParseGroupNode(nodePtr(t, children[0]))
	if err != nil {
		t.Fatalf("ParseGroupNode: %v", err)
	}
	if info.JID.String() != "120363043777777777@g.us" {
		t.Errorf("JID = %s, want 120363043777777777@g.us", info.JID)
	}
	if info.Name != "Sync Crew" {
		t.Errorf("Name = %q, want Sync Crew", info.Name)
	}
	if info.ParticipantCount != 3 {
		t.Errorf("ParticipantCount = %d, want 3", info.ParticipantCount)
	}
	if !info.GroupCreated.Equal(time.Unix(1757751000, 0)) {
		t.Errorf("GroupCreated = %v, want %v", info.GroupCreated, time.Unix(1757751000, 0))
	}
	if !info.IsAnnounce || !info.IsLocked {
		t.Errorf("announce/locked = %v/%v, want true/true", info.IsAnnounce, info.IsLocked)
	}
	if info.Topic != "on-call rota" {
		t.Errorf("Topic = %q, want on-call rota", info.Topic)
	}
}
