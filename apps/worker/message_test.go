package main

import (
	"encoding/json"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"
)

// ---- the text helpers the Hermes ingest path shares ------------------------

// foldText builds the searchable form of a message body: case-folded, punctuation
// turned into word boundaries, whitespace collapsed. Punctuation becomes a space
// rather than disappearing so "deploy-green" still matches "deploy green" (§6.4).
func TestFoldTextNormalizesSearchableText(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Deploy is green", "deploy is green"},
		{"deploy-green", "deploy green"},
		{"  spaced\t\tout  ", "spaced out"},
		{"Quarterly chart: Q3 (final)", "quarterly chart q3 final"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := foldText(tc.in); got != tc.want {
			t.Errorf("foldText(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// collectLinks extracts bare and scheme-qualified URLs without the sentence
// punctuation that usually follows them.
func TestCollectLinksStripsTrailingPunctuation(t *testing.T) {
	got := collectLinks("see https://status.test/deploy, and www.example.test/x. done")
	want := []string{"https://status.test/deploy", "www.example.test/x"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("collectLinks = %v, want %v", got, want)
	}
	if links := collectLinks("no links here"); len(links) != 0 {
		t.Errorf("collectLinks = %v, want none", links)
	}
}

// dedupeStrings drops empties and repeats while keeping first-seen order: a
// forwarded message repeats its mention list per variant.
func TestDedupeStringsKeepsFirstSeenOrder(t *testing.T) {
	got := dedupeStrings([]string{"b", "", "a", "b", "a", "c"})
	want := []string{"b", "a", "c"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("dedupeStrings = %v, want %v", got, want)
	}
}

func TestApplyRawLimitsBindsConfigCapsToParser(t *testing.T) {
	restoreJSON, restoreSearch := rawJSONMaxBytes, rawSearchMaxBytes
	t.Cleanup(func() {
		rawJSONMaxBytes, rawSearchMaxBytes = restoreJSON, restoreSearch
	})

	applyRawLimits(Config{RawJSONMaxBytes: 2048, RawSearchMax: 48})
	if rawJSONMaxBytes != 2048 || rawSearchMaxBytes != 48 {
		t.Fatalf("limits = %d/%d, want the configured 2048/48", rawJSONMaxBytes, rawSearchMaxBytes)
	}

	raw, rawSearch, err := externalRaw(externalEvent{
		MessageID: "3EB0D1", ChatID: "120363043123456789@g.us", SenderID: "628990000001@s.whatsapp.net",
		Body: "quarterly chart " + strings.Repeat("x", 4096),
	})
	if err != nil {
		t.Fatalf("externalRaw: %v", err)
	}
	stored, err := json.Marshal(raw.Message)
	if err != nil {
		t.Fatalf("marshal stored raw tree: %v", err)
	}
	if !raw.Truncated || len(stored) > 2048 {
		t.Errorf("stored raw tree is %d bytes (truncated=%v), want at most the configured 2048", len(stored), raw.Truncated)
	}
	if len(rawSearch) > 48 {
		t.Errorf("rawSearch is %d bytes, want at most the configured 48", len(rawSearch))
	}
	if !strings.HasPrefix(rawSearch, "quarterly chart") {
		t.Errorf("rawSearch = %q, want the message text first (R4)", rawSearch)
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
