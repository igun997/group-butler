package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func evtMessage(chat, sender types.JID, id string, msg *waE2E.Message) *events.Message {
	return &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{Chat: chat, Sender: sender, IsGroup: chat.Server == types.GroupServer},
			ID:            types.MessageID(id),
			Timestamp:     time.Unix(1757751120, 0),
			PushName:      "Nadia",
		},
		Message: msg,
	}
}

func TestParseInbound_GroupText(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	sender := types.NewJID("628990000001", types.DefaultUserServer)
	got, err := parseInbound(evtMessage(chat, sender, "3EB0A1", &waE2E.Message{Conversation: proto.String("deploy is green")}), "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if got.GroupJID != "120363043123456789@g.us" || got.Kind != KindText || got.Text != "deploy is green" {
		t.Errorf("doc = %+v", got)
	}
	if got.OrganizationID != "org_default" || got.InstanceID != "inst_1" {
		t.Error("tenant/instance not stamped from the caller")
	}
	if got.Media.Status != MediaNone {
		t.Errorf("Media.Status = %q, want none", got.Media.Status)
	}
}

func TestParseInbound_DoesNotSkipOwnMessages(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	evt := evtMessage(chat, types.NewJID("628990000009", types.DefaultUserServer), "3EB0A2",
		&waE2E.Message{Conversation: proto.String("sent from the phone")})
	evt.Info.IsFromMe = true
	got, err := parseInbound(evt, "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if !got.FromMe {
		t.Error("FromMe = false: the butler ingests its own group messages (R1)")
	}
}

func TestParseInbound_InteractiveResponseIsNotDropped(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	evt := evtMessage(chat, types.NewJID("628990000001", types.DefaultUserServer), "3EB0A3",
		&waE2E.Message{ListResponseMessage: &waE2E.ListResponseMessage{Title: proto.String("Approve")}})
	got, err := parseInbound(evt, "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if got.Text != "Approve" {
		t.Errorf("Text = %q, want the tapped row title", got.Text)
	}
}

func TestParseInbound_UnknownKindStillRecorded(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	evt := evtMessage(chat, types.NewJID("628990000001", types.DefaultUserServer), "3EB0A4", &waE2E.Message{})
	got, err := parseInbound(evt, "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if got.Kind != KindUnknown || got.ParseState != ParsePartial {
		t.Errorf("kind=%q parseState=%q, want unknown/partial (record, never drop)", got.Kind, got.ParseState)
	}
}

func TestParseInbound_MediaIsPendingWithDeclaredType(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	sender := types.NewJID("628990000001", types.DefaultUserServer)
	image := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Caption:  proto.String("the chart"),
		Mimetype: proto.String("image/jpeg"),
	}}

	got, err := parseInbound(evtMessage(chat, sender, "3EB0B1", image), "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if got.Kind != KindImage || got.Text != "the chart" {
		t.Errorf("kind=%q text=%q, want image with its caption", got.Kind, got.Text)
	}
	want := Media{Status: MediaPending, Kind: KindImage, DeclaredType: KindImage}
	if got.Media != want {
		// The document is written before the bytes are fetched, so the attachment
		// must already announce what WhatsApp claimed for it (R3, §6.2).
		t.Errorf("Media = %+v, want %+v", got.Media, want)
	}

	// A view-once image is the same attachment behind a wrapper: the inner node
	// decides the kind, the wrapper decides the declared type.
	wrapped := &waE2E.Message{ViewOnceMessageV2: &waE2E.FutureProofMessage{Message: image}}
	got, err = parseInbound(evtMessage(chat, sender, "3EB0B2", wrapped), "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound(view once): %v", err)
	}
	if got.Kind != KindImage || got.Text != "the chart" {
		t.Errorf("wrapped: kind=%q text=%q, want the inner image and caption", got.Kind, got.Text)
	}
	if got.Media.Kind != KindImage || got.Media.DeclaredType != "view_once" {
		t.Errorf("wrapped: Media = %+v, want kind=image declaredType=view_once", got.Media)
	}
}

func TestParseInbound_FoldsTextAndCollectsLinksAndMentions(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	sender := types.NewJID("628990000001", types.DefaultUserServer)
	mention := "628990000002@s.whatsapp.net"
	msg := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text: proto.String("Deploy, GREEN! see https://status.test/deploy."),
		ContextInfo: &waE2E.ContextInfo{
			MentionedJID: []string{mention, mention, ""},
		},
	}}
	got, err := parseInbound(evtMessage(chat, sender, "3EB0B3", msg), "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if got.TextSearch != "deploy green see https status test deploy" {
		t.Errorf("TextSearch = %q, want the case-folded, punctuation-free body", got.TextSearch)
	}
	if len(got.Links) != 1 || got.Links[0] != "https://status.test/deploy" {
		t.Errorf("Links = %v, want the URL without the sentence's full stop", got.Links)
	}
	if len(got.Mentions) != 1 || got.Mentions[0] != mention {
		t.Errorf("Mentions = %v, want the deduplicated mentioned JID", got.Mentions)
	}
	if got.SenderJID != "628990000001@s.whatsapp.net" || got.ChatJID != "120363043123456789@g.us" {
		t.Errorf("sender=%q chat=%q, want the event's own JIDs", got.SenderJID, got.ChatJID)
	}
	if !got.Timestamp.Equal(time.Unix(1757751120, 0)) {
		t.Errorf("Timestamp = %v, want the event's WhatsApp timestamp", got.Timestamp)
	}
	if got.SchemaVersion != messageSchemaVersion {
		t.Errorf("SchemaVersion = %d, want %d", got.SchemaVersion, messageSchemaVersion)
	}
}

func TestParseInbound_TruncatesOversizedRawTree(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	msg := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Caption:       proto.String("quarterly chart"),
		Mimetype:      proto.String("image/jpeg"),
		JPEGThumbnail: make([]byte, 4096),
	}}

	intact, err := parseInbound(evtMessage(chat, types.NewJID("628990000001", types.DefaultUserServer), "3EB0B4", msg), "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	if intact.Raw.Truncated {
		t.Error("a message under the cap must be stored whole")
	}
	if _, ok := intact.Raw.Message["imageMessage"]; !ok {
		t.Errorf("raw.message = %v, want the intact image node", intact.Raw.Message)
	}

	restore := rawJSONMaxBytes
	rawJSONMaxBytes = 1024
	t.Cleanup(func() { rawJSONMaxBytes = restore })

	capped, err := parseInbound(evtMessage(chat, types.NewJID("628990000001", types.DefaultUserServer), "3EB0B5", msg), "org_default", "inst_1")
	if err != nil {
		t.Fatalf("parseInbound(capped): %v", err)
	}
	stored, err := json.Marshal(capped.Raw.Message)
	if err != nil {
		t.Fatalf("marshal stored raw tree: %v", err)
	}
	if !capped.Raw.Truncated {
		t.Error("raw.truncated = false although the tree did not fit the cap")
	}
	if len(stored) > rawJSONMaxBytes {
		t.Errorf("stored raw tree is %d bytes, want at most %d", len(stored), rawJSONMaxBytes)
	}
	if capped.Raw.Bytes <= rawJSONMaxBytes {
		t.Errorf("raw.bytes = %d, want the full serialized size so the loss is visible", capped.Raw.Bytes)
	}
	if !strings.Contains(capped.RawSearch, "quarterly chart") {
		t.Errorf("rawSearch = %q, want the caption to stay searchable after pruning (R4)", capped.RawSearch)
	}
}
