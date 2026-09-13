package main

import (
	"encoding/json"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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

// nativeFlowResponse builds the payload WhatsApp sends when a user taps a native
// flow control. The label travels twice: body.text for the client UI and
// paramsJson for the machine.
func nativeFlowResponse(body, params string) *waE2E.Message {
	response := &waE2E.InteractiveResponseMessage{
		InteractiveResponseMessage: &waE2E.InteractiveResponseMessage_NativeFlowResponseMessage_{
			NativeFlowResponseMessage: &waE2E.InteractiveResponseMessage_NativeFlowResponseMessage{
				Name:       proto.String("single_select"),
				ParamsJSON: proto.String(params),
			},
		},
	}
	if body != "" {
		response.Body = &waE2E.InteractiveResponseMessage_Body{Text: proto.String(body)}
	}
	return &waE2E.Message{InteractiveResponseMessage: response}
}

// TestParseInbound_NativeFlowResponseIsReadable is the regression for the missed
// variant: a native flow tap is user input, so it must be stored as readable
// text rather than as an empty unknown message (§6.2).
func TestParseInbound_NativeFlowResponseIsReadable(t *testing.T) {
	chat := types.NewJID("120363043123456789", types.GroupServer)
	sender := types.NewJID("628990000001", types.DefaultUserServer)
	cases := []struct {
		name string
		msg  *waE2E.Message
		want string
	}{
		{
			name: "body and params agree",
			msg:  nativeFlowResponse("Approve the deploy", `{"selectedId":"approve","selectedDisplayText":"Approve the deploy"}`),
			want: "Approve the deploy",
		},
		{
			name: "params only, snake case label",
			msg:  nativeFlowResponse("", `{"selectedId":"ship","display_text":"Standard shipping"}`),
			want: "Standard shipping",
		},
		{
			name: "params only, camel case label",
			msg:  nativeFlowResponse("", `{"id":"opt_123","displayText":"View balance"}`),
			want: "View balance",
		},
		{
			name: "multi select",
			msg:  nativeFlowResponse("", `{"selected_display_texts":["Deploy","Rollback"]}`),
			want: "Deploy, Rollback",
		},
		{
			name: "label-less client sends only the id",
			msg:  nativeFlowResponse("", `{"selectedId":"approve"}`),
			want: "approve",
		},
		{
			name: "flow form with no label keeps the payload",
			msg:  nativeFlowResponse("", `{"flow_token":"tok_123"}`),
			want: `{"flow_token":"tok_123"}`,
		},
	}
	for _, tc := range cases {
		got, err := parseInbound(evtMessage(chat, sender, "3EB0C1", tc.msg), "org_default", "inst_1")
		if err != nil {
			t.Fatalf("%s: parseInbound: %v", tc.name, err)
		}
		if got.Kind != KindText {
			t.Errorf("%s: Kind = %q, want text: a tapped control is user input", tc.name, got.Kind)
		}
		if got.Text != tc.want {
			t.Errorf("%s: Text = %q, want %q", tc.name, got.Text, tc.want)
		}
		if got.ParseState != ParseOK {
			t.Errorf("%s: ParseState = %q (%v), want ok: the variant is understood", tc.name, got.ParseState, got.ParseErrors)
		}
		if _, ok := got.Raw.Message["interactiveResponseMessage"]; !ok {
			t.Errorf("%s: raw.message = %v, want the response tree", tc.name, got.Raw.Message)
		}
	}
}

// TestApplyRawLimitsBindsConfigCapsToParser pins the wiring: the caps the parser
// actually applies are the ones Config carries, not the baked-in defaults.
func TestApplyRawLimitsBindsConfigCapsToParser(t *testing.T) {
	restoreJSON, restoreSearch := rawJSONMaxBytes, rawSearchMaxBytes
	t.Cleanup(func() {
		rawJSONMaxBytes, rawSearchMaxBytes = restoreJSON, restoreSearch
	})

	applyRawLimits(Config{RawJSONMaxBytes: 2048, RawSearchMax: 48})
	if rawJSONMaxBytes != 2048 || rawSearchMaxBytes != 48 {
		t.Fatalf("limits = %d/%d, want the configured 2048/48", rawJSONMaxBytes, rawSearchMaxBytes)
	}

	msg := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Caption:       proto.String("quarterly chart"),
		Mimetype:      proto.String("image/jpeg"),
		JPEGThumbnail: make([]byte, 4096),
	}}
	got, err := parseInbound(
		evtMessage(types.NewJID("120363043123456789", types.GroupServer), types.NewJID("628990000001", types.DefaultUserServer), "3EB0D1", msg),
		"org_default", "inst_1",
	)
	if err != nil {
		t.Fatalf("parseInbound: %v", err)
	}
	stored, err := json.Marshal(got.Raw.Message)
	if err != nil {
		t.Fatalf("marshal stored raw tree: %v", err)
	}
	if !got.Raw.Truncated || len(stored) > 2048 {
		t.Errorf("stored raw tree is %d bytes (truncated=%v), want at most the configured 2048", len(stored), got.Raw.Truncated)
	}
	if len(got.RawSearch) > 48 {
		t.Errorf("rawSearch is %d bytes, want at most the configured 48", len(got.RawSearch))
	}
	if !strings.HasPrefix(got.RawSearch, "quarterly chart") {
		t.Errorf("rawSearch = %q, want the message text first (R4)", got.RawSearch)
	}
}

// TestBoundedTextStopsAtTheCap pins the writer's two invariants: it never exceeds
// the cap and it never splits a rune, so collection can stop mid-leaf.
func TestBoundedTextStopsAtTheCap(t *testing.T) {
	b := newBoundedText(10)
	b.Add("12345")
	b.Add("67890")
	b.Add("never collected")
	if got, want := b.String(), "12345\n6789"; got != want {
		t.Errorf("bounded text = %q, want %q", got, want)
	}
	if !b.full {
		t.Error("the writer did not report itself full after the cap was reached")
	}

	u := newBoundedText(4)
	u.Add("ééé")
	if got := u.String(); got != "éé" {
		t.Errorf("bounded text = %q, want the two whole runes that fit", got)
	}
	if !utf8.ValidString(u.String()) {
		t.Error("the cap split a rune: the value is not valid UTF-8")
	}
}

// TestRawSearchTextKeepsOnlyWhatFitsTheCap pins the cap end-to-end on a tree whose
// first leaf alone fills it: the text is exactly the cap, never more.
func TestRawSearchTextKeepsOnlyWhatFitsTheCap(t *testing.T) {
	restore := rawSearchMaxBytes
	rawSearchMaxBytes = 32
	t.Cleanup(func() { rawSearchMaxBytes = restore })

	tree := map[string]any{
		"a": strings.Repeat("x", 4096), // sorts first, fills the cap on its own
		"b": "collected after the cap",
	}
	if got, want := rawSearchText(tree), strings.Repeat("x", 32); got != want {
		t.Errorf("rawSearch = %q, want exactly the cap", got)
	}
}

// TestRawSearchTextDoesNotMaterialiseTheWholeTree is the memory side of the same
// guarantee: collection stops at the cap while walking, so a megabyte payload is
// never flattened into a string that would be trimmed to a few bytes. The
// measurable difference is the copy of the payload itself.
func TestRawSearchTextDoesNotMaterialiseTheWholeTree(t *testing.T) {
	restore := rawSearchMaxBytes
	rawSearchMaxBytes = 32
	t.Cleanup(func() { rawSearchMaxBytes = restore })

	const payload = 1 << 20
	tree := map[string]any{"a": strings.Repeat("x", payload)}

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	got := rawSearchText(tree)
	runtime.ReadMemStats(&after)

	if want := strings.Repeat("x", 32); got != want {
		t.Fatalf("rawSearch = %d bytes, want the cap", len(got))
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > payload/4 {
		t.Errorf("collecting the search text allocated %d bytes: the tree was flattened before being capped", allocated)
	}
}
