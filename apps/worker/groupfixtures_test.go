package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/types"
)

var (
	testGroupJID   = types.NewJID("120363043123456789", types.GroupServer)
	testOtherGroup = types.NewJID("120363043999999999", types.GroupServer)
	testSelfPN     = types.NewJID("628990000009", types.DefaultUserServer)
	testAdminPN    = types.NewJID("628990000001", types.DefaultUserServer)
	testRenameAt   = time.Unix(1757751120, 0)
)

func unixAttr(t time.Time) string { return strconv.FormatInt(t.Unix(), 10) }

// assertFixtureFidelity proves the hand-built node matches the captured wire
// transcript, so the parser assertions in groupparse_test.go are about real
// WhatsApp shapes rather than about our assumptions (docs/architecture-draft.md
// §14.1).
func assertFixtureFidelity(t *testing.T, name string, node waBinary.Node) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if got, want := node.String(), strings.TrimSpace(string(raw)); got != want {
		t.Fatalf("fixture %s drifted from the captured transcript\n got: %s\nwant: %s", name, got, want)
	}
}

func renameNotificationNode() waBinary.Node {
	return waBinary.Node{
		Tag: "notification",
		Attrs: waBinary.Attrs{
			"from": testGroupJID, "type": "w:gp2",
			"t": unixAttr(testRenameAt), "notify": "Ops Team", "participant": testAdminPN,
		},
		Content: []waBinary.Node{{
			Tag: "subject",
			Attrs: waBinary.Attrs{
				"subject": "Ops Team", "s_t": unixAttr(testRenameAt), "s_o": testAdminPN,
			},
		}},
	}
}

func createNotificationNode() waBinary.Node {
	created := time.Unix(1757751200, 0)
	return waBinary.Node{
		Tag: "notification",
		Attrs: waBinary.Attrs{
			"from": testOtherGroup, "type": "w:gp2", "id": unixAttr(created),
			"t": unixAttr(created), "notify": "New Crew", "participant": testAdminPN,
		},
		Content: []waBinary.Node{{
			Tag: "create",
			Attrs: waBinary.Attrs{
				"key": "3EB0CREATE", "reason": "invite", "type": "new",
			},
			Content: []waBinary.Node{{
				Tag: "group",
				Attrs: waBinary.Attrs{
					// The group node's `id` is the bare user part, not a JID:
					// parseGroupNode composes `<id>@g.us` itself (group.go:705),
					// and AttrUtility rejects a JID-typed `id` because String()
					// requires a string ("expected attribute 'id' to be string").
					"id": "120363043999999999", "subject": "New Crew",
					"s_t": unixAttr(created), "s_o": testAdminPN,
					"creation": unixAttr(created), "size": "3",
				},
				Content: []waBinary.Node{{
					Tag: "participant", Attrs: waBinary.Attrs{"jid": testAdminPN, "type": "superadmin"},
				}},
			}},
		}},
	}
}

func deleteNotificationNode() waBinary.Node {
	return waBinary.Node{
		Tag: "notification",
		Attrs: waBinary.Attrs{
			"from": testGroupJID, "type": "w:gp2",
			"t": unixAttr(time.Unix(1757751300, 0)), "participant": testAdminPN,
		},
		Content: []waBinary.Node{{Tag: "delete", Attrs: waBinary.Attrs{"reason": "user_left"}}},
	}
}

func selfRemovalNotificationNode() waBinary.Node {
	return waBinary.Node{
		Tag: "notification",
		Attrs: waBinary.Attrs{
			"from": testGroupJID, "type": "w:gp2",
			"t": unixAttr(time.Unix(1757751400, 0)), "participant": testSelfPN,
		},
		Content: []waBinary.Node{{
			Tag:   "remove",
			Attrs: waBinary.Attrs{"v_id": "2"},
			Content: []waBinary.Node{{
				Tag: "participant", Attrs: waBinary.Attrs{"jid": testSelfPN},
			}},
		}},
	}
}

func unknownChildNotificationNode() waBinary.Node {
	return waBinary.Node{
		Tag: "notification",
		Attrs: waBinary.Attrs{
			"from": testGroupJID, "type": "w:gp2",
			"t": unixAttr(time.Unix(1757751500, 0)), "participant": testAdminPN,
		},
		Content: []waBinary.Node{{Tag: "future_feature", Attrs: waBinary.Attrs{"flag": "on"}}},
	}
}

// syncGroupsNode is the `<groups>` element of a `GetJoinedGroups` response: the
// authoritative membership snapshot a full sync consumes (§6.6.5).
func syncGroupsNode() waBinary.Node {
	created := time.Unix(1757751000, 0)
	return waBinary.Node{
		Tag: "groups",
		Content: []waBinary.Node{{
			Tag: "group",
			Attrs: waBinary.Attrs{
				"id": "120363043777777777", "subject": "Sync Crew",
				"s_t": unixAttr(created), "s_o": testAdminPN, "creation": unixAttr(created), "size": "3",
			},
			Content: []waBinary.Node{
				{Tag: "participant", Attrs: waBinary.Attrs{"jid": testAdminPN, "type": "superadmin"}},
				{Tag: "announcement", Attrs: waBinary.Attrs{"v_id": "1"}},
				{Tag: "locked", Attrs: waBinary.Attrs{"v_id": "2"}},
				{
					Tag:   "description",
					Attrs: waBinary.Attrs{"id": "d1", "t": unixAttr(created)},
					Content: []waBinary.Node{{
						Tag: "body", Content: []byte("on-call rota"),
					}},
				},
			},
		}},
	}
}

// nodePtr returns the address of a fixture node: the whatsmeow test surface
// takes pointers, while the builders above stay value-typed so XMLString can be
// asserted on the same value the parser receives.
func nodePtr(t *testing.T, node waBinary.Node) *waBinary.Node {
	t.Helper()
	return &node
}
