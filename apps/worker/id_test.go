package main

import "testing"

func TestNewIDShape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 500; i++ {
		id := newID()
		if len(id) != 21 {
			t.Fatalf("newID() = %q (len %d), want 21 chars", id, len(id))
		}
		if seen[id] {
			t.Fatalf("newID() repeated %q", id)
		}
		seen[id] = true
	}
}
