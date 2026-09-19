package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const dispatchLockTTL = time.Minute

// sendProvenance is the stored record of what produced a send (§5.1). The BFF
// writes it; the worker reads one field of it — the message this send answers —
// and the reply is built from that id rather than from anything the dispatcher
// could infer.
type sendProvenance struct {
	ReplyToMessageID string `bson:"replyToMessageId"`
}

type dispatchRequest struct {
	ID             string `bson:"id"`
	OrganizationID string `bson:"organizationId"`
	InstanceID     string `bson:"instanceId"`
	// GroupJID is the chat the request belongs to: a group JID for a group chat,
	// the owner's own user JID for a direct one. ChatKind says which, and a row
	// without it is a group — the shape every row written before the field
	// existed has.
	GroupJID     string    `bson:"groupJid"`
	ChatKind     string    `bson:"chatKind"`
	Text         string    `bson:"text"`
	Status       string    `bson:"status"`
	ScheduledFor time.Time `bson:"scheduledFor"`
	// Provenance is empty for a send created any other way, which is every send
	// that is not a reply.
	Provenance sendProvenance `bson:"provenance"`
}

type sendDispatcher struct {
	requests *mongo.Collection
	// messages is where the send's reply target is looked up: the quote has to
	// name the sender of the message being answered, and that is stored on the
	// message itself.
	messages    *mongo.Collection
	workerID    string
	orgID       string
	maxAttempts int
	interval    time.Duration
	newTicker   func(time.Duration) (<-chan time.Time, func())
}

func newSendDispatcher(db *mongo.Database, cfg Config) *sendDispatcher {
	return &sendDispatcher{
		requests:    db.Collection(collSendRequests),
		messages:    db.Collection(collMessages),
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
	// Resolved before the send begins: the quote has to name a participant
	// before any client call, so a request whose quoted message is not stored
	// fails as a refusal rather than as a half-delivered reply.
	quote, err := d.quoteTarget(ctx, request)
	if err != nil {
		return d.refused(ctx, mgr, request, err)
	}
	messageID, err := mgr.sendText(ctx, request, quote)
	if err != nil {
		return d.refused(ctx, mgr, request, err)
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
	// Counted once the request is stored as `sent`: the number has to describe a
	// delivery the dispatcher also recorded, not one whose record was lost.
	mgr.recordSend(ctx, request.InstanceID, request.GroupJID, true, time.Now())
	return nil
}

// refused records one send the worker never handed to WhatsApp, in the row and
// in the counters the console shows (§10). The send is the event the counters
// describe, so it is counted here: the caller only logs the returned error, and
// a failure that nothing counted would leave the console's send success rate at
// 100%.
func (d *sendDispatcher) refused(ctx context.Context, mgr *manager, request dispatchRequest, cause error) error {
	mgr.recordSend(ctx, request.InstanceID, request.GroupJID, false, time.Now())
	return d.failed(ctx, request.ID, classifySendFailure(cause), cause)
}

// errQuoteTargetUnavailable is the sentinel for a request that answers a message
// this worker does not hold. It is matched as a value so the failure class does
// not drift with the message text.
var errQuoteTargetUnavailable = errors.New("quoted message is not stored")

// quoteTarget resolves the message a request answers, or the zero value for a
// request that answers nothing — the shape every send without reply provenance
// has. The participant comes from the stored message's `senderJid`: WhatsApp
// resolves a quote by that JID, and a reply that named the sending account
// instead would quote the wrong author in every group.
func (d *sendDispatcher) quoteTarget(ctx context.Context, request dispatchRequest) (quotedMessage, error) {
	id := strings.TrimSpace(request.Provenance.ReplyToMessageID)
	if id == "" {
		return quotedMessage{}, nil
	}
	var row struct {
		SenderJID string `bson:"senderJid"`
	}
	err := d.messages.FindOne(
		ctx,
		bson.D{
			{Key: "organizationId", Value: d.orgID},
			{Key: "instanceId", Value: request.InstanceID},
			{Key: "waMessageId", Value: id},
		},
		options.FindOne().SetProjection(bson.D{{Key: "senderJid", Value: 1}}),
	).Decode(&row)
	if errors.Is(err, mongo.ErrNoDocuments) || (err == nil && row.SenderJID == "") {
		return quotedMessage{}, fmt.Errorf("%w: %s", errQuoteTargetUnavailable, id)
	}
	if err != nil {
		return quotedMessage{}, fmt.Errorf("read quoted message %s: %w", id, err)
	}
	return quotedMessage{ID: id, Participant: row.SenderJID}, nil
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

// sendText performs one send through the Hermes bridge, which owns the WhatsApp
// connection now. `quote` names the message this send answers — the dispatcher
// resolved it from the request's provenance and the stored message — and the zero
// value sends the plain text the request asks for.
//
// The id this returns is the one the bridge's send assigned: the worker no longer
// chooses it, because the process that holds the socket is the one that knows what
// WhatsApp accepted.
func (m *manager) sendText(ctx context.Context, request dispatchRequest, quote quotedMessage) (string, error) {
	send, err := buildOutboundSend(outboundText{
		GroupJID: request.GroupJID, ChatKind: request.ChatKind, Text: request.Text, Quote: quote,
	})
	if err != nil {
		return "", err
	}
	if m.bridge == nil {
		return "", errNoBridge
	}
	return m.bridge.SendText(ctx, send.ChatID, send.Text, send.Reply)
}

// classifySendFailure decides whether a failed send may be retried, which is the
// one thing the console's retry button acts on. Only the failures that cannot have
// reached WhatsApp are `rejected`; everything else is `ambiguous`, because a
// delivery that may have happened is not one a retry may double-post.
func classifySendFailure(err error) string {
	// Decided before anything was handed over: a request whose quoted message the
	// worker does not hold, and a bridge that refused the call outright — it is not
	// there, or its WhatsApp session is down. Nothing can have been sent.
	if errors.Is(err, errQuoteTargetUnavailable) || errors.Is(err, errBridgeNotConnected) {
		return "rejected"
	}
	// A call that timed out is the one case the worker cannot reason about: the
	// bridge was up, the send went out, and no acknowledgement came back. It may
	// have been delivered, so a new approval is the only safe recovery path.
	if errors.Is(err, errBridgeTimeout) {
		return "ambiguous"
	}
	// A connection this worker could not even open is the same as a refusal.
	if errors.Is(err, errBridgeUnreachable) || errors.Is(err, errNoBridge) {
		return "rejected"
	}
	return "ambiguous"
}
