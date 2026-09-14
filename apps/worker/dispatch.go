package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const dispatchLockTTL = time.Minute

type dispatchRequest struct {
	ID             string    `bson:"id"`
	OrganizationID string    `bson:"organizationId"`
	InstanceID     string    `bson:"instanceId"`
	GroupJID       string    `bson:"groupJid"`
	Text           string    `bson:"text"`
	Status         string    `bson:"status"`
	ScheduledFor   time.Time `bson:"scheduledFor"`
}

type sendDispatcher struct {
	requests    *mongo.Collection
	workerID    string
	orgID       string
	maxAttempts int
	interval    time.Duration
	newTicker   func(time.Duration) (<-chan time.Time, func())
}

func newSendDispatcher(db *mongo.Database, cfg Config) *sendDispatcher {
	return &sendDispatcher{
		requests:    db.Collection(collSendRequests),
		workerID:    newID(),
		orgID:       cfg.OrganizationID,
		maxAttempts: cfg.SendMaxAttempts,
		interval:    cfg.DispatchInterval,
		newTicker: func(d time.Duration) (<-chan time.Time, func()) {
			ticker := time.NewTicker(d)
			return ticker.C, ticker.Stop
		},
	}
}

// run claims requests at startup as well as on each tick, so a request approved
// while the worker was down is not delayed by one whole dispatch interval.
func (d *sendDispatcher) run(ctx context.Context, mgr *manager) {
	mgr.loops.declare(loopSendDispatch, d.interval)
	d.dispatchDue(ctx, mgr)
	ticks, stop := d.newTicker(d.interval)
	defer stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			mgr.loops.pass(loopSendDispatch, time.Now(), d.dispatchDue(ctx, mgr))
		}
	}
}

// dispatchDue claims and delivers every due request. A claim failure is returned
// so the loop's pass reports it: an individual delivery failure is already the
// request's own business, but being unable to read the queue is not.
func (d *sendDispatcher) dispatchDue(ctx context.Context, mgr *manager) error {
	for {
		request, err := d.claim(ctx, time.Now().UTC())
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil
		}
		if err != nil {
			logf("send dispatch claim: %v", err)
			return err
		}
		if err := d.deliver(ctx, mgr, request); err != nil {
			logf("send dispatch %s: %v", request.ID, err)
		}
	}
}

func (d *sendDispatcher) claim(ctx context.Context, now time.Time) (dispatchRequest, error) {
	staleBefore := now.Add(-dispatchLockTTL)
	filter := bson.D{
		{Key: "organizationId", Value: d.orgID},
		{Key: "dispatch.attempts", Value: bson.D{{Key: "$lt", Value: d.maxAttempts}}},
		{Key: "$or", Value: bson.A{
			bson.D{{Key: "status", Value: "approved"}, {Key: "scheduledFor", Value: bson.D{{Key: "$lte", Value: now}}}},
			bson.D{{Key: "status", Value: "scheduled"}, {Key: "scheduledFor", Value: bson.D{{Key: "$lte", Value: now}}}},
		}},
		{Key: "$or", Value: bson.A{
			bson.D{{Key: "dispatch.lockedAt", Value: nil}},
			bson.D{{Key: "dispatch.lockedAt", Value: bson.D{{Key: "$lt", Value: staleBefore}}}},
		}},
	}
	update := bson.D{
		{Key: "$set", Value: bson.D{
			{Key: "status", Value: "sending"},
			{Key: "dispatch.lockedAt", Value: now},
			{Key: "dispatch.lockedBy", Value: d.workerID},
			{Key: "updatedAt", Value: now},
		}},
		{Key: "$inc", Value: bson.D{{Key: "dispatch.attempts", Value: 1}}},
	}
	var request dispatchRequest
	err := d.requests.FindOneAndUpdate(
		ctx,
		filter,
		update,
		options.FindOneAndUpdate().SetSort(bson.D{{Key: "scheduledFor", Value: 1}}).SetReturnDocument(options.After),
	).Decode(&request)
	return request, err
}

func (d *sendDispatcher) deliver(ctx context.Context, mgr *manager, request dispatchRequest) error {
	messageID, err := mgr.sendText(ctx, request)
	if err != nil {
		return d.failed(ctx, request.ID, classifySendFailure(err), err)
	}
	result, err := d.requests.UpdateOne(
		ctx,
		bson.D{{Key: "organizationId", Value: d.orgID}, {Key: "id", Value: request.ID}, {Key: "status", Value: "sending"}, {Key: "dispatch.lockedBy", Value: d.workerID}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: "sent"},
			{Key: "dispatch.waMessageId", Value: messageID},
			{Key: "dispatch.lockedAt", Value: nil},
			{Key: "dispatch.lockedBy", Value: nil},
			{Key: "dispatch.errorClass", Value: nil},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}}},
	)
	if err != nil {
		return fmt.Errorf("mark sent: %w", err)
	}
	if result.MatchedCount == 0 {
		return errors.New("send claim was lost before acknowledgement was stored")
	}
	return nil
}

func (d *sendDispatcher) failed(ctx context.Context, id, class string, cause error) error {
	message := strings.TrimSpace(cause.Error())
	if len(message) > 512 {
		message = message[:512]
	}
	_, err := d.requests.UpdateOne(
		ctx,
		bson.D{{Key: "organizationId", Value: d.orgID}, {Key: "id", Value: id}, {Key: "status", Value: "sending"}, {Key: "dispatch.lockedBy", Value: d.workerID}},
		bson.D{{Key: "$set", Value: bson.D{
			{Key: "status", Value: "failed"},
			{Key: "dispatch.errorClass", Value: class},
			{Key: "dispatch.error", Value: message},
			{Key: "dispatch.lockedAt", Value: nil},
			{Key: "dispatch.lockedBy", Value: nil},
			{Key: "updatedAt", Value: time.Now().UTC()},
		}}},
	)
	if err != nil {
		return fmt.Errorf("mark failed: %w", err)
	}
	return nil
}

var errDispatchInstanceOffline = errors.New("send instance is not connected")

func (m *manager) sendText(ctx context.Context, request dispatchRequest) (string, error) {
	session := m.get(request.InstanceID)
	if session == nil || session.snapshot().Status != stateConnected {
		return "", errDispatchInstanceOffline
	}
	to, message, err := buildTextEnvelope(outboundText{ID: request.ID, GroupJID: request.GroupJID, Text: request.Text})
	if err != nil {
		return "", err
	}
	_ = session.client.SendChatPresence(ctx, to, types.ChatPresenceComposing, types.ChatPresenceMediaText)
	defer func() {
		_ = session.client.SendChatPresence(context.WithoutCancel(ctx), to, types.ChatPresencePaused, types.ChatPresenceMediaText)
	}()
	response, err := session.client.SendMessage(ctx, to, message, whatsmeow.SendRequestExtra{ID: types.MessageID(request.ID)})
	if err != nil {
		return "", err
	}
	if response.ID == "" {
		return "", errors.New("whatsapp acknowledged send without a message id")
	}
	return string(response.ID), nil
}

func classifySendFailure(err error) string {
	if errors.Is(err, errDispatchInstanceOffline) {
		return "rejected"
	}
	// An error after SendMessage begins may mean WhatsApp accepted the request but
	// its acknowledgement was lost. Retrying would double-post; a new approval is
	// the only safe recovery path.
	return "ambiguous"
}
