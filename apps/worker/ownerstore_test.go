package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// fakeClock is the TTL seam: a test that must prove the owner list is re-read
// after its interval cannot sleep for it.
type fakeClock struct {
	mu sync.Mutex
	at time.Time
}

func newFakeClock(at time.Time) *fakeClock { return &fakeClock{at: at} }

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

// stubOwnerRead stands in for the one Mongo read the store performs, so the TTL
// policy is provable without a database: the test decides which organization
// document says what, and when.
type stubOwnerRead struct {
	mu    sync.Mutex
	byOrg map[string][]string
	calls map[string]int
	err   error
}

func newStubOwnerRead(orgID string, jids ...string) *stubOwnerRead {
	s := &stubOwnerRead{calls: map[string]int{}}
	s.set(orgID, jids, nil)
	return s
}

func (s *stubOwnerRead) load(_ context.Context, orgID string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.calls == nil {
		s.calls = map[string]int{}
	}
	s.calls[orgID]++
	return s.byOrg[orgID], s.err
}

func (s *stubOwnerRead) set(orgID string, jids []string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.byOrg == nil {
		s.byOrg = map[string][]string{}
	}
	s.byOrg[orgID], s.err = jids, err
}

func (s *stubOwnerRead) count(orgID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[orgID]
}

func testOwnerStore(clock *fakeClock, read *stubOwnerRead) *ownerStore {
	return &ownerStore{ttl: ownerListTTL, countryCode: "62", now: clock.now, load: read.load}
}

// The dashboard may hold an entry the operator typed rather than a value the
// BFF canonicalized, and every form names one account: the canonical JID with
// or without a device suffix, and the national form an operator writes their
// own number in. Anything that cannot name a phone account is not a match.
func TestOwnerPhoneSetReadsEveryStoredFormOfOneNumber(t *testing.T) {
	phones := ownerPhoneSet([]string{
		"628996926184@s.whatsapp.net",
		"628996926185:9@s.whatsapp.net",
		"0899 6926 186",
		"not-a-jid",
		"120363043123456789@g.us",
		"",
	}, "62")

	for _, want := range []string{"628996926184", "628996926185", "628996926186"} {
		if _, ok := phones[want]; !ok {
			t.Errorf("owner set %v is missing %q", phones, want)
		}
	}
	if len(phones) != 3 {
		t.Errorf("owner set = %v, want exactly the three phone numbers", phones)
	}
}

// A failed read authorizes nobody: the gate's answer is "not proven an owner",
// never "no list, so anyone".
func TestOwnerStoreFailsClosedOnAReadError(t *testing.T) {
	clock := newFakeClock(time.Unix(1757750000, 0))
	read := &stubOwnerRead{}
	read.set("org_default", nil, errors.New("mongo down"))
	store := testOwnerStore(clock, read)

	phones, err := store.allowedPhones(context.Background(), "org_default")
	if err == nil {
		t.Fatal("allowedPhones returned no error although the read failed")
	}
	if len(phones) != 0 {
		t.Errorf("phones = %v, want none on a failed read", phones)
	}
}

// The cache holds one organization's list, so a lookup for another tenant must
// read that tenant's document rather than answer with what it happens to hold:
// serving the wrong list would authorize the wrong owners.
func TestOwnerStoreDoesNotAnswerAnotherOrganizationFromTheCache(t *testing.T) {
	clock := newFakeClock(time.Unix(1757750000, 0))
	read := newStubOwnerRead("org_a", "628996926184@s.whatsapp.net")
	store := testOwnerStore(clock, read)
	ctx := context.Background()

	if _, err := store.allowedPhones(ctx, "org_a"); err != nil {
		t.Fatalf("allowedPhones for org_a: %v", err)
	}
	read.set("org_b", []string{"628990000777@s.whatsapp.net"}, nil)

	phones, err := store.allowedPhones(ctx, "org_b")
	if err != nil {
		t.Fatalf("allowedPhones for org_b: %v", err)
	}
	if read.count("org_b") != 1 {
		t.Fatalf("reads for org_b = %d, want its own document read", read.count("org_b"))
	}
	if _, ok := phones["628996926184"]; ok {
		t.Fatalf("org_b was answered with org_a's owner list: %v", phones)
	}
	if _, ok := phones["628990000777"]; !ok {
		t.Fatalf("phones = %v, want org_b's own owner", phones)
	}
}

// The list is the BFF's and the operator can change it while this worker runs,
// so the answer must expire: a second lookup inside the interval is served from
// the cache, and the next one re-reads and picks up the owner just added.
func TestOwnerStoreRereadsTheListAfterItsTTL(t *testing.T) {
	clock := newFakeClock(time.Unix(1757750000, 0))
	read := newStubOwnerRead("org_default", "628996926184@s.whatsapp.net")
	store := testOwnerStore(clock, read)
	ctx := context.Background()

	first, err := store.allowedPhones(ctx, "org_default")
	if err != nil {
		t.Fatalf("allowedPhones: %v", err)
	}
	if _, ok := first["628996926184"]; !ok {
		t.Fatalf("first read = %v, want the stored owner", first)
	}

	// A lookup inside the interval costs no second read.
	if _, err := store.allowedPhones(ctx, "org_default"); err != nil {
		t.Fatalf("allowedPhones: %v", err)
	}
	if read.count("org_default") != 1 {
		t.Fatalf("reads = %d, want 1 inside the TTL", read.count("org_default"))
	}

	read.set("org_default", []string{"628996926184@s.whatsapp.net", "628996926185@s.whatsapp.net"}, nil)
	clock.advance(ownerListTTL)

	refreshed, err := store.allowedPhones(ctx, "org_default")
	if err != nil {
		t.Fatalf("allowedPhones after TTL: %v", err)
	}
	if read.count("org_default") != 2 {
		t.Fatalf("reads = %d, want the list re-read after its TTL", read.count("org_default"))
	}
	if _, ok := refreshed["628996926185"]; !ok {
		t.Fatalf("refreshed list = %v, want the owner authorized while the worker ran", refreshed)
	}
}

// The stored list is read from the `organizations` document the BFF owns, keyed
// by the organization id: the filter, the projection and the field spelling are
// the driver's, so only a real database proves them.
func TestOwnerStoreReadsTheOrganizationsOwnerListFromMongo(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()
	client, db, err := connectMongo(ctx, testMongoURI(t), "group_butler_test")
	if err != nil {
		t.Fatalf("connectMongo: %v", err)
	}
	defer func() { _ = client.Disconnect(ctx) }()

	const orgID = "org_owner_store_test"
	coll := db.Collection(collOrganizations)
	if _, err := coll.DeleteOne(ctx, bson.D{{Key: "_id", Value: orgID}}); err != nil {
		t.Fatalf("clean organization: %v", err)
	}
	defer func() { _, _ = coll.DeleteOne(ctx, bson.D{{Key: "_id", Value: orgID}}) }()

	// No organization row yet is the empty list, not an error.
	phones, err := newOwnerStore(db, "62").allowedPhones(ctx, orgID)
	if err != nil {
		t.Fatalf("allowedPhones without a row: %v", err)
	}
	if len(phones) != 0 {
		t.Fatalf("phones = %v, want none before any owner is stored", phones)
	}

	if _, err := coll.InsertOne(ctx, bson.D{
		{Key: "_id", Value: orgID},
		{Key: "config", Value: bson.D{{Key: "autoReplyAuthorizedJids", Value: bson.A{
			"628996926184@s.whatsapp.net",
			"628996926185:9@s.whatsapp.net",
		}}}},
	}); err != nil {
		t.Fatalf("insert organization: %v", err)
	}

	// A fresh store is what a TTL expiry produces: the worker reads the
	// organization document again and sees whatever the BFF last wrote.
	phones, err = newOwnerStore(db, "62").allowedPhones(ctx, orgID)
	if err != nil {
		t.Fatalf("allowedPhones after the insert: %v", err)
	}
	for _, want := range []string{"628996926184", "628996926185"} {
		if _, ok := phones[want]; !ok {
			t.Errorf("phones = %v, want %q read from organizations.config.autoReplyAuthorizedJids", phones, want)
		}
	}
}
