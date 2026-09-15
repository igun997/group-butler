package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	memoryBatchMaxAttempts = 5
	memoryBatchLease       = 2 * time.Minute
	memoryBatchHeartbeat   = 30 * time.Second
	memoryBatchLimit       = 100
	memoryBatchEqualLimit  = 150
	memoryBatchWindow      = 24 * time.Hour
)

const memoryBatchOrigin = "origin"

const memoryCleanupTimeout = 5 * time.Second

func memoryCleanupContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(parent), memoryCleanupTimeout)
}

type memoryBatchState string

const (
	memoryBatchReady      memoryBatchState = "ready"
	memoryBatchProcessing memoryBatchState = "processing"
	memoryBatchRetryWait  memoryBatchState = "retry_wait"
	memoryBatchComplete   memoryBatchState = "complete"
	memoryBatchDead       memoryBatchState = "dead"
)

type memoryFailureClass string

const (
	memoryFailureRetryable memoryFailureClass = "retryable"
	memoryFailureTerminal  memoryFailureClass = "terminal"
)

type memoryBatchKey struct {
	Timestamp   time.Time `bson:"timestamp" json:"timestamp"`
	WaMessageID string    `bson:"waMessageId" json:"waMessageId"`
}

func memoryBatchPredecessor(key memoryBatchKey) string {
	return key.Timestamp.UTC().Format(time.RFC3339Nano) + "\x00" + key.WaMessageID
}

type memoryBatchLeaseDoc struct {
	Owner     string    `bson:"owner"`
	Token     string    `bson:"token"`
	ExpiresAt time.Time `bson:"expiresAt"`
}

type memoryBatchFailure struct {
	Code    string    `bson:"code"`
	Message string    `bson:"message"`
	At      time.Time `bson:"at"`
}

type memoryBatch struct {
	ID                 bson.ObjectID        `bson:"_id,omitempty"`
	OrganizationID     string               `bson:"organizationId"`
	InstanceID         string               `bson:"instanceId"`
	GroupJID           string               `bson:"groupJid"`
	First              memoryBatchKey       `bson:"first"`
	Last               memoryBatchKey       `bson:"last"`
	Predecessor        string               `bson:"predecessor"`
	SourceCount        int                  `bson:"sourceCount"`
	SourceWaMessageIDs []string             `bson:"sourceWaMessageIds"`
	SourceTextBytes    int                  `bson:"sourceTextBytes"`
	State              memoryBatchState     `bson:"state"`
	Lease              *memoryBatchLeaseDoc `bson:"lease"`
	Attempts           int                  `bson:"attempts"`
	NextAttemptAt      *time.Time           `bson:"nextAttemptAt"`
	Failure            *memoryBatchFailure  `bson:"failure"`
	SummaryID          *bson.ObjectID       `bson:"summaryId"`
	CreatedAt          time.Time            `bson:"createdAt"`
	StartedAt          *time.Time           `bson:"startedAt"`
	CompletedAt        *time.Time           `bson:"completedAt"`
	UpdatedAt          time.Time            `bson:"updatedAt"`
}

type memoryBatchMessage struct {
	Timestamp   time.Time `bson:"timestamp"`
	WaMessageID string    `bson:"waMessageId"`
	Text        string    `bson:"text"`
}

type memoryBatchGroup struct {
	InstanceID string `bson:"instanceId"`
	GroupJID   string `bson:"groupJid"`
}

type memoryBatchStore struct {
	organizationID               string
	groups                       *mongo.Collection
	messages                     *mongo.Collection
	batches                      *mongo.Collection
	settings                     *mongo.Collection
	beforeMemoryBatchMaterialize func()
}

func newMemoryBatchStore(db *mongo.Database, organizationID string) *memoryBatchStore {
	return &memoryBatchStore{
		organizationID: organizationID,
		groups:         db.Collection(collGroups),
		messages:       db.Collection(collMessages),
		batches:        db.Collection(collMemoryBatches),
		settings:       db.Collection(collAppSettings),
	}
}

type memoryProcessorSlot struct {
	ID             string    `bson:"_id"`
	OrganizationID string    `bson:"organizationId"`
	Slot           int       `bson:"slot"`
	Owner          string    `bson:"owner"`
	Token          string    `bson:"token"`
	ExpiresAt      time.Time `bson:"expiresAt"`
	UpdatedAt      time.Time `bson:"updatedAt"`
}

func memoryProcessorSlotID(organizationID string, slot int) string {
	return "memoryBatchSlot:" + organizationID + ":" + fmt.Sprintf("%d", slot)
}

func (s *memoryBatchStore) AcquireProcessorSlot(ctx context.Context, at time.Time, owner string, limit int) (*memoryProcessorSlot, error) {
	for slot := range limit {
		token := uuid.NewString()
		var claimed memoryProcessorSlot
		err := s.settings.FindOneAndUpdate(ctx, bson.D{
			{Key: "_id", Value: memoryProcessorSlotID(s.organizationID, slot)},
			{Key: "organizationId", Value: s.organizationID},
			{Key: "$or", Value: bson.A{
				bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$lte", Value: at}}}},
				bson.D{{Key: "expiresAt", Value: bson.D{{Key: "$exists", Value: false}}}},
			}},
		}, bson.D{{Key: "$set", Value: bson.D{
			{Key: "organizationId", Value: s.organizationID},
			{Key: "slot", Value: slot},
			{Key: "owner", Value: owner},
			{Key: "token", Value: token},
			{Key: "expiresAt", Value: at.Add(memoryBatchLease)},
			{Key: "updatedAt", Value: at},
		}}}, options.FindOneAndUpdate().SetUpsert(true).SetReturnDocument(options.After)).Decode(&claimed)
		if err == nil {
			return &claimed, nil
		}
		if errors.Is(err, mongo.ErrNoDocuments) || mongo.IsDuplicateKeyError(err) {
			continue
		}
		return nil, fmt.Errorf("acquire memory processor slot: %w", err)
	}
	return nil, nil
}

func (s *memoryBatchStore) HeartbeatProcessorSlot(ctx context.Context, slot *memoryProcessorSlot, at time.Time) (bool, error) {
	result, err := s.settings.UpdateOne(ctx, bson.D{{Key: "_id", Value: slot.ID}, {Key: "organizationId", Value: s.organizationID}, {Key: "owner", Value: slot.Owner}, {Key: "token", Value: slot.Token}}, bson.D{{Key: "$set", Value: bson.D{{Key: "expiresAt", Value: at.Add(memoryBatchLease)}, {Key: "updatedAt", Value: at}}}})
	if err != nil {
		return false, fmt.Errorf("heartbeat memory processor slot: %w", err)
	}
	return result.MatchedCount == 1, nil
}

func (s *memoryBatchStore) ReleaseProcessorSlot(ctx context.Context, slot *memoryProcessorSlot, at time.Time) {
	_, _ = s.settings.UpdateOne(ctx, bson.D{{Key: "_id", Value: slot.ID}, {Key: "organizationId", Value: s.organizationID}, {Key: "owner", Value: slot.Owner}, {Key: "token", Value: slot.Token}}, bson.D{{Key: "$set", Value: bson.D{{Key: "expiresAt", Value: at}, {Key: "updatedAt", Value: at}}}})
}

// eligible at the instant of the scan. It advances only from completed ranges:
// an outstanding range is re-inserted idempotently rather than skipped.
func (s *memoryBatchStore) BuildReady(ctx context.Context, at time.Time) error {
	groups, err := s.eligibleGroups(ctx)
	if err != nil {
		return err
	}
	for _, group := range groups {
		if err := s.buildGroup(ctx, group, at.UTC()); err != nil {
			return err
		}
	}
	return nil
}

func (s *memoryBatchStore) eligibleGroups(ctx context.Context) ([]memoryBatchGroup, error) {
	cursor, err := s.groups.Find(ctx, bson.D{
		{Key: "organizationId", Value: s.organizationID},
		{Key: "config.assigned", Value: true},
		{Key: "config.whitelisted", Value: true},
	}, options.Find().SetProjection(bson.D{{Key: "instanceId", Value: 1}, {Key: "groupJid", Value: 1}}))
	if err != nil {
		return nil, fmt.Errorf("scan eligible memory groups: %w", err)
	}
	defer func() { _ = cursor.Close(ctx) }()
	groups := make([]memoryBatchGroup, 0)
	for cursor.Next(ctx) {
		var group memoryBatchGroup
		if err := cursor.Decode(&group); err != nil {
			return nil, fmt.Errorf("decode eligible memory group: %w", err)
		}
		groups = append(groups, group)
	}
	if err := cursor.Err(); err != nil {
		return nil, fmt.Errorf("scan eligible memory groups: %w", err)
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].InstanceID == groups[j].InstanceID {
			return groups[i].GroupJID < groups[j].GroupJID
		}
		return groups[i].InstanceID < groups[j].InstanceID
	})
	return groups, nil
}

func (s *memoryBatchStore) buildGroup(ctx context.Context, group memoryBatchGroup, at time.Time) error {
	outstanding, err := s.hasOutstandingRange(ctx, group)
	if err != nil {
		return err
	}
	if outstanding {
		return nil
	}
	watermark, err := s.completedWatermark(ctx, group)
	if err != nil {
		return err
	}
	predecessor := memoryBatchOrigin
	if watermark != nil {
		predecessor = memoryBatchPredecessor(*watermark)
	}
	rows, err := s.nextMessages(ctx, group, watermark)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	if s.beforeMemoryBatchMaterialize != nil {
		s.beforeMemoryBatchMaterialize()
	}
	due := at
	batch := memoryBatch{
		OrganizationID: s.organizationID,
		InstanceID:     group.InstanceID,
		GroupJID:       group.GroupJID,
		Predecessor:    predecessor,
		First:          memoryBatchKey{Timestamp: rows[0].Timestamp, WaMessageID: rows[0].WaMessageID},
		Last:           memoryBatchKey{Timestamp: rows[len(rows)-1].Timestamp, WaMessageID: rows[len(rows)-1].WaMessageID},
		SourceCount:    len(rows),
		State:          memoryBatchReady,
		NextAttemptAt:  &due,
		CreatedAt:      at,
		UpdatedAt:      at,
	}
	for _, row := range rows {
		batch.SourceTextBytes += len([]byte(row.Text))
		batch.SourceWaMessageIDs = append(batch.SourceWaMessageIDs, row.WaMessageID)
	}
	_, err = s.batches.InsertOne(ctx, batch)
	if err != nil && !mongo.IsDuplicateKeyError(err) {
		return fmt.Errorf("materialize memory batch %s: %w", group.GroupJID, err)
	}
	return nil
}

func (s *memoryBatchStore) hasOutstandingRange(ctx context.Context, group memoryBatchGroup) (bool, error) {
	count, err := s.batches.CountDocuments(ctx, bson.D{
		{Key: "organizationId", Value: s.organizationID},
		{Key: "instanceId", Value: group.InstanceID},
		{Key: "groupJid", Value: group.GroupJID},
		{Key: "state", Value: bson.D{{Key: "$ne", Value: memoryBatchComplete}}},
	}, options.Count().SetLimit(1))
	if err != nil {
		return false, fmt.Errorf("check outstanding memory batch: %w", err)
	}
	return count > 0, nil
}

func (s *memoryBatchStore) completedWatermark(ctx context.Context, group memoryBatchGroup) (*memoryBatchKey, error) {
	var batch memoryBatch
	err := s.batches.FindOne(ctx, bson.D{
		{Key: "organizationId", Value: s.organizationID},
		{Key: "instanceId", Value: group.InstanceID},
		{Key: "groupJid", Value: group.GroupJID},
		{Key: "state", Value: memoryBatchComplete},
	}, options.FindOne().SetSort(bson.D{{Key: "last.timestamp", Value: -1}, {Key: "last.waMessageId", Value: -1}}).SetProjection(bson.D{{Key: "last", Value: 1}})).Decode(&batch)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read completed memory watermark: %w", err)
	}
	return &batch.Last, nil
}

func (s *memoryBatchStore) nextMessages(ctx context.Context, group memoryBatchGroup, watermark *memoryBatchKey) ([]memoryBatchMessage, error) {
	filter := bson.D{
		{Key: "organizationId", Value: s.organizationID},
		{Key: "instanceId", Value: group.InstanceID},
		{Key: "groupJid", Value: group.GroupJID},
		{Key: "flags.revoked", Value: bson.D{{Key: "$ne", Value: true}}},
		{Key: "kind", Value: bson.D{{Key: "$ne", Value: KindRevoked}}},
	}
	if watermark != nil {
		filter = append(filter, bson.E{Key: "$or", Value: bson.A{
			bson.D{{Key: "timestamp", Value: bson.D{{Key: "$gt", Value: watermark.Timestamp}}}},
			bson.D{{Key: "timestamp", Value: watermark.Timestamp}, {Key: "waMessageId", Value: bson.D{{Key: "$gt", Value: watermark.WaMessageID}}}},
		}})
	}
	cursor, err := s.messages.Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "timestamp", Value: 1}, {Key: "waMessageId", Value: 1}}).SetLimit(memoryBatchEqualLimit+1).SetProjection(bson.D{{Key: "timestamp", Value: 1}, {Key: "waMessageId", Value: 1}, {Key: "text", Value: 1}}))
	if err != nil {
		return nil, fmt.Errorf("scan memory messages: %w", err)
	}
	defer func() { _ = cursor.Close(ctx) }()
	rows := make([]memoryBatchMessage, 0, memoryBatchEqualLimit+1)
	for cursor.Next(ctx) {
		var row memoryBatchMessage
		if err := cursor.Decode(&row); err != nil {
			return nil, fmt.Errorf("decode memory message: %w", err)
		}
		rows = append(rows, row)
	}
	if err := cursor.Err(); err != nil {
		return nil, fmt.Errorf("scan memory messages: %w", err)
	}
	if len(rows) == 0 {
		return nil, nil
	}
	windowEnd := rows[0].Timestamp.Add(memoryBatchWindow)
	bounded := rows[:0]
	for _, row := range rows {
		if row.Timestamp.After(windowEnd) {
			break
		}
		bounded = append(bounded, row)
	}
	if len(bounded) <= memoryBatchLimit {
		return bounded, nil
	}
	end := memoryBatchLimit
	equalAt := bounded[memoryBatchLimit-1].Timestamp
	for end < len(bounded) && end < memoryBatchEqualLimit && bounded[end].Timestamp.Equal(equalAt) {
		end++
	}
	return bounded[:end], nil
}

// Claim atomically leases the oldest due batch. Recovery makes a stale
// processing lease retryable before this method evaluates ready/retry work.
func (s *memoryBatchStore) Claim(ctx context.Context, at time.Time, owner string) (*memoryBatch, error) {
	token := uuid.NewString()
	expiresAt := at.Add(memoryBatchLease)
	startedAt := at
	update := mongo.Pipeline{bson.D{{Key: "$set", Value: bson.D{
		{Key: "state", Value: memoryBatchProcessing},
		{Key: "lease", Value: memoryBatchLeaseDoc{Owner: owner, Token: token, ExpiresAt: expiresAt}},
		{Key: "attempts", Value: bson.D{{Key: "$add", Value: bson.A{"$attempts", 1}}}},
		{Key: "startedAt", Value: bson.D{{Key: "$ifNull", Value: bson.A{"$startedAt", startedAt}}}},
		{Key: "updatedAt", Value: at},
	}}}}
	var batch memoryBatch
	err := s.batches.FindOneAndUpdate(ctx, bson.D{
		{Key: "organizationId", Value: s.organizationID},
		{Key: "state", Value: bson.D{{Key: "$in", Value: bson.A{memoryBatchReady, memoryBatchRetryWait}}}},
		{Key: "attempts", Value: bson.D{{Key: "$lt", Value: memoryBatchMaxAttempts}}},
		{Key: "nextAttemptAt", Value: bson.D{{Key: "$lte", Value: at}}},
		{Key: "$or", Value: bson.A{
			bson.D{{Key: "lease", Value: nil}},
			bson.D{{Key: "lease.expiresAt", Value: bson.D{{Key: "$lte", Value: at}}}},
		}},
	}, update, options.FindOneAndUpdate().SetSort(bson.D{{Key: "createdAt", Value: 1}}).SetReturnDocument(options.After)).Decode(&batch)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("claim memory batch: %w", err)
	}
	return &batch, nil
}

func (s *memoryBatchStore) Heartbeat(ctx context.Context, id bson.ObjectID, token string, at time.Time) (bool, error) {
	result, err := s.batches.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "organizationId", Value: s.organizationID}, {Key: "state", Value: memoryBatchProcessing}, {Key: "lease.token", Value: token}}, bson.D{{Key: "$set", Value: bson.D{{Key: "lease.expiresAt", Value: at.Add(memoryBatchLease)}, {Key: "updatedAt", Value: at}}}})
	if err != nil {
		return false, fmt.Errorf("heartbeat memory batch: %w", err)
	}
	return result.MatchedCount == 1, nil
}

func (s *memoryBatchStore) RecoverExpired(ctx context.Context, at time.Time) error {
	expired := bson.D{
		{Key: "organizationId", Value: s.organizationID},
		{Key: "state", Value: memoryBatchProcessing},
		{Key: "lease.expiresAt", Value: bson.D{{Key: "$lte", Value: at}}},
	}
	if _, err := s.batches.UpdateMany(ctx, append(expired, bson.E{Key: "attempts", Value: bson.D{{Key: "$gte", Value: memoryBatchMaxAttempts}}}), bson.D{{Key: "$set", Value: bson.D{{Key: "state", Value: memoryBatchDead}, {Key: "lease", Value: nil}, {Key: "nextAttemptAt", Value: nil}, {Key: "updatedAt", Value: at}}}}); err != nil {
		return fmt.Errorf("mark expired exhausted memory batches dead: %w", err)
	}
	if _, err := s.batches.UpdateMany(ctx, append(expired, bson.E{Key: "attempts", Value: bson.D{{Key: "$lt", Value: memoryBatchMaxAttempts}}}), bson.D{{Key: "$set", Value: bson.D{{Key: "state", Value: memoryBatchRetryWait}, {Key: "lease", Value: nil}, {Key: "nextAttemptAt", Value: at}, {Key: "updatedAt", Value: at}}}}); err != nil {
		return fmt.Errorf("recover expired memory batch leases: %w", err)
	}
	return nil
}

func (s *memoryBatchStore) Fail(ctx context.Context, id bson.ObjectID, token string, at time.Time, class memoryFailureClass, code, message string) error {
	var batch memoryBatch
	if err := s.batches.FindOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "organizationId", Value: s.organizationID}, {Key: "state", Value: memoryBatchProcessing}, {Key: "lease.token", Value: token}}, options.FindOne().SetProjection(bson.D{{Key: "attempts", Value: 1}})).Decode(&batch); err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		return fmt.Errorf("read failing memory batch: %w", err)
	}
	state := memoryBatchRetryWait
	var nextAttemptAt *time.Time
	if class == memoryFailureTerminal || batch.Attempts >= memoryBatchMaxAttempts {
		state = memoryBatchDead
	} else {
		due := at.Add(memoryRetryDelayJittered(id, batch.Attempts))
		nextAttemptAt = &due
	}
	result, err := s.batches.UpdateOne(ctx, bson.D{{Key: "_id", Value: id}, {Key: "organizationId", Value: s.organizationID}, {Key: "state", Value: memoryBatchProcessing}, {Key: "lease.token", Value: token}}, bson.D{{Key: "$set", Value: bson.D{{Key: "state", Value: state}, {Key: "lease", Value: nil}, {Key: "nextAttemptAt", Value: nextAttemptAt}, {Key: "failure", Value: memoryBatchFailure{Code: code, Message: message, At: at}}, {Key: "updatedAt", Value: at}}}})
	if err != nil {
		return fmt.Errorf("fail memory batch: %w", err)
	}
	if result.MatchedCount != 1 {
		return nil
	}
	return nil
}

// memoryRetryDelay is bounded before the multiplication can overflow.
func memoryRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 8 {
		return 6 * time.Hour
	}
	delay := 5 * time.Minute * time.Duration(1<<(attempt-1))
	if delay > 6*time.Hour {
		return 6 * time.Hour
	}
	return delay
}

// The deterministic jitter avoids synchronized retries while keeping an
// ambiguous write's retry time reproducible for the same batch and attempt.
func memoryRetryDelayJittered(id bson.ObjectID, attempt int) time.Duration {
	base := memoryRetryDelay(attempt)
	digest := sha256.Sum256(append(id[:], byte(attempt)))
	fraction := float64(binary.BigEndian.Uint16(digest[:2])) / 65535
	return time.Duration(float64(base) * (0.8 + 0.4*fraction))
}

type memoryBatchWorker struct {
	store  *memoryBatchStore
	cfg    Config
	owner  string
	client *http.Client

	slotOnce sync.Once
	slots    chan struct{}
}

func newMemoryBatchWorker(db *mongo.Database, cfg Config) *memoryBatchWorker {
	return &memoryBatchWorker{
		store:  newMemoryBatchStore(db, cfg.OrganizationID),
		cfg:    cfg,
		owner:  uuid.NewString(),
		client: &http.Client{Timeout: 30 * time.Second},
		slots:  make(chan struct{}, cfg.MemoryBatchConcurrency),
	}
}

func (w *memoryBatchWorker) Run(ctx context.Context, newTicker func(time.Duration) (<-chan time.Time, func()), loops *loopRegistry) {
	ticks, stop := newTicker(w.cfg.MemoryBatchEvery)
	defer stop()
	loops.declare(loopMemoryBatches, w.cfg.MemoryBatchEvery)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			err := w.RunOnce(ctx, time.Now().UTC())
			loops.pass(loopMemoryBatches, time.Now(), err)
		}
	}
}

func (w *memoryBatchWorker) RunOnce(ctx context.Context, at time.Time) error {
	if err := w.store.BuildReady(ctx, at); err != nil {
		return err
	}
	if err := w.store.RecoverExpired(ctx, at); err != nil {
		return err
	}
	if w.cfg.MemoryCallbackURL == "" {
		return nil
	}
	var workers sync.WaitGroup
	for range w.cfg.MemoryBatchConcurrency {
		select {
		case <-ctx.Done():
			workers.Wait()
			return ctx.Err()
		case w.processorSlots() <- struct{}{}:
		}
		slot, err := w.store.AcquireProcessorSlot(ctx, at, w.owner, w.cfg.MemoryBatchConcurrency)
		if err != nil {
			<-w.processorSlots()
			workers.Wait()
			return err
		}
		if slot == nil {
			<-w.processorSlots()
			break
		}
		batch, err := w.store.Claim(ctx, at, w.owner)
		if err != nil {
			w.releaseProcessorSlot(ctx, slot)
			<-w.processorSlots()
			workers.Wait()
			return err
		}
		if batch == nil {
			w.releaseProcessorSlot(ctx, slot)
			<-w.processorSlots()
			break
		}
		workers.Add(1)
		go func(claimed *memoryBatch, processorSlot *memoryProcessorSlot) {
			defer workers.Done()
			defer func() { <-w.processorSlots() }()
			defer w.releaseProcessorSlot(ctx, processorSlot)
			w.deliver(ctx, claimed, processorSlot)
		}(batch, slot)
	}
	workers.Wait()
	return nil
}

// processorSlots is this worker process's memory processor limit. A token is
// acquired before Claim, so no more than MEMORY_BATCH_CONCURRENCY Mongo leases
// can be active across overlapping scheduler passes in this process.
func (w *memoryBatchWorker) processorSlots() chan struct{} {
	w.slotOnce.Do(func() {
		capacity := w.cfg.MemoryBatchConcurrency
		if capacity < 1 {
			capacity = 1
		}
		w.slots = make(chan struct{}, capacity)
	})
	return w.slots
}

func (w *memoryBatchWorker) releaseProcessorSlot(parent context.Context, slot *memoryProcessorSlot) {
	cleanup, cancel := memoryCleanupContext(parent)
	defer cancel()
	w.store.ReleaseProcessorSlot(cleanup, slot, time.Now().UTC())
}

func (w *memoryBatchWorker) failBatch(parent context.Context, batch *memoryBatch, class memoryFailureClass, code, message string) {
	cleanup, cancel := memoryCleanupContext(parent)
	defer cancel()
	_ = w.store.Fail(cleanup, batch.ID, batch.Lease.Token, time.Now().UTC(), class, code, message)
}

func memoryCallbackFailureClass(status int) memoryFailureClass {
	if status >= http.StatusBadRequest && status < http.StatusInternalServerError && status != http.StatusRequestTimeout && status != http.StatusTooManyRequests {
		return memoryFailureTerminal
	}
	return memoryFailureRetryable
}

type memoryBatchCallbackPayload struct {
	BatchID string `json:"batchId"`
}

func (w *memoryBatchWorker) deliver(ctx context.Context, batch *memoryBatch, processorSlot *memoryProcessorSlot) {
	if batch.Lease == nil {
		return
	}
	stop := make(chan struct{})
	var heartbeat sync.WaitGroup
	heartbeat.Add(1)
	go func() {
		defer heartbeat.Done()
		ticker := time.NewTicker(memoryBatchHeartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case tick := <-ticker.C:
				batchAlive, err := w.store.Heartbeat(ctx, batch.ID, batch.Lease.Token, tick.UTC())
				if err != nil || !batchAlive {
					return
				}
				slotAlive, err := w.store.HeartbeatProcessorSlot(ctx, processorSlot, tick.UTC())
				if err != nil || !slotAlive {
					return
				}
			}
		}
	}()
	defer func() {
		close(stop)
		heartbeat.Wait()
	}()

	body, err := json.Marshal(memoryBatchCallbackPayload{BatchID: batch.ID.Hex()})
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.cfg.MemoryCallbackURL, bytes.NewReader(body))
	if err != nil {
		w.failBatch(ctx, batch, memoryFailureRetryable, "callback_request", err.Error())
		return
	}
	req.Header.Set("Authorization", "Bearer "+w.cfg.MemoryCallbackSecret)
	req.Header.Set("Content-Type", "application/json")
	resp, err := w.client.Do(req)
	status := 0
	if err == nil && resp != nil {
		status = resp.StatusCode
		_ = resp.Body.Close()
	}
	if err != nil || resp == nil || status < http.StatusOK || status >= http.StatusMultipleChoices {
		message := "non-success callback response"
		if err != nil {
			message = err.Error()
		}
		w.failBatch(ctx, batch, memoryCallbackFailureClass(status), "callback", message)
	}
}
