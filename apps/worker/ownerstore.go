package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// ownerListTTL is how long one read of the organization's reply-owner list is
// trusted. The BFF rewrites that list from the dashboard while this worker runs,
// so the answer has to expire on its own — an owner added at 10:00 must start
// working at 10:00:30 without a restart — and a TTL is what keeps the steady
// state one read per interval instead of one per direct message.
const ownerListTTL = 30 * time.Second

// ownerAllowlist is the gate's view of who may direct-message the bot.
//
// It answers in the form the match is made in — E.164 digits, which is what
// both the dashboard's canonical JIDs and the sender's JID reduce to — so a
// caller never re-derives the matching rule. Returning the set rather than a
// verdict keeps the sender-side rule (device suffix, alternate address) in the
// gate, where it is exercised by the direct-message tests.
type ownerAllowlist interface {
	allowedPhones(ctx context.Context, orgID string) (map[string]struct{}, error)
}

// ownerStore reads `organizations.config.autoReplyAuthorizedJids`, the list the
// BFF owns, and caches it for ownerListTTL.
//
// A failed read authorizes nobody: an unreadable list is not an empty one to be
// ignored, and the message that arrived during the failure is dropped rather
// than stored on a guess.
type ownerStore struct {
	coll        *mongo.Collection
	countryCode string
	ttl         time.Duration

	// now and load are the seams: the expiry policy is provable without sleeping
	// for it, and without a database to change the document underneath it.
	now  func() time.Time
	load func(ctx context.Context, orgID string) ([]string, error)

	mu      sync.Mutex
	orgID   string
	phones  map[string]struct{}
	expires time.Time
}

func newOwnerStore(db *mongo.Database, countryCode string) *ownerStore {
	store := &ownerStore{
		coll:        db.Collection(collOrganizations),
		countryCode: countryCode,
		ttl:         ownerListTTL,
		now:         func() time.Time { return time.Now() },
	}
	store.load = store.readJids
	return store
}

// allowedPhones returns the cached list while it is fresh and re-reads it when
// it is not. A read error is returned as such: the caller drops the message and
// logs, which is the same outcome as an empty list but visible.
func (s *ownerStore) allowedPhones(ctx context.Context, orgID string) (map[string]struct{}, error) {
	if phones, ok := s.cached(orgID); ok {
		return phones, nil
	}
	entries, err := s.load(ctx, orgID)
	if err != nil {
		return nil, err
	}
	phones := ownerPhoneSet(entries, s.countryCode)
	s.mu.Lock()
	s.orgID, s.phones, s.expires = orgID, phones, s.now().Add(s.ttl)
	s.mu.Unlock()
	return phones, nil
}

// cached returns the list while it is inside its interval and belongs to the
// organization being asked about. Two direct messages that arrive together may
// both load; the answer they store is the same, so the duplicate read costs
// nothing beyond one round trip.
//
// The organization is part of the key because the cache holds exactly one list:
// answering another tenant's question from it would authorize the wrong owners,
// which is the one failure this store must not have.
func (s *ownerStore) cached(orgID string) (map[string]struct{}, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.phones == nil || s.orgID != orgID || !s.now().Before(s.expires) {
		return nil, false
	}
	return s.phones, true
}

// organizationOwnerDoc is the one field this store reads back. The organization
// document is keyed by `_id` — the same id the BFF's dashboard edits — and the
// list is projected on its own so a read never carries the rest of the
// organization across the wire (the worker has no business holding it).
type organizationOwnerDoc struct {
	Config struct {
		AutoReplyAuthorizedJids []string `bson:"autoReplyAuthorizedJids"`
	} `bson:"config"`
}

func (s *ownerStore) readJids(ctx context.Context, orgID string) ([]string, error) {
	var doc organizationOwnerDoc
	err := s.coll.FindOne(ctx,
		bson.D{{Key: "_id", Value: orgID}},
		options.FindOne().SetProjection(bson.D{{Key: "config.autoReplyAuthorizedJids", Value: 1}}),
	).Decode(&doc)
	if errors.Is(err, mongo.ErrNoDocuments) {
		// An organization with no document yet has authorized nobody, which is
		// the same answer as an empty list.
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return doc.Config.AutoReplyAuthorizedJids, nil
}

// ownerPhoneSet reduces the stored list to the phone numbers the gate compares.
// The BFF writes canonical user JIDs, but the dashboard is not the only writer
// that ever existed, so an entry is read the way the config layer already reads
// an operator-written number: national form expanded, device suffix dropped, and
// anything that does not name a phone account — a group JID, a typo — left out
// rather than stored as a match nothing can ever produce.
func ownerPhoneSet(entries []string, countryCode string) map[string]struct{} {
	phones := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if phone := ownerPhoneDigits(entry, countryCode); phone != "" {
			phones[phone] = struct{}{}
		}
	}
	return phones
}
