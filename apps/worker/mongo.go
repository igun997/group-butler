package main

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Collection names (docs/architecture-draft.md §5.1).
const (
	collInstances       = "instances"
	collGroups          = "groups"
	collMessages        = "messages"
	collMemoryBatches   = "memoryBatches"
	collMemorySummaries = "memorySummaries"
	collMemoryFacts     = "memoryFacts"
	collAgentReplyRuns  = "agentReplyRuns"
	collSendRequests    = "sendRequests"
	collAiCalls         = "aiCalls"
	collStatsDaily      = "statsDaily"
	collAuditLog        = "auditLog"
	collPairingSession  = "pairingSessions"
	collAppSettings     = "appSettings"
	collOrganizations   = "organizations"
)

// mongoPing is the connection handshake as a seam: connectMongo's failure path
// is only observable from a client whose handshake was forced to fail.
var mongoPing = func(ctx context.Context, client *mongo.Client) error {
	return client.Ping(ctx, nil)
}

func connectMongo(ctx context.Context, uri, dbName string) (*mongo.Client, *mongo.Database, error) {
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		return nil, nil, fmt.Errorf("mongo connect: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := mongoPing(pingCtx, client); err != nil {
		// The handshake failed, so this client is ours alone to close: returning
		// it as nil without disconnecting would leak its connection pool and
		// topology monitor for the life of the process. The caller's context may
		// already be the reason the ping failed, so the close gets its own
		// deadline rather than inheriting a dead one.
		closeCtx, cancelClose := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancelClose()
		_ = client.Disconnect(closeCtx)
		return nil, nil, fmt.Errorf("mongo ping: %w", err)
	}
	return client, client.Database(dbName), nil
}

// indexSpec is a collection's index described by key names in order. The
// driver's IndexModel hides its keys behind `any`, so the worker keeps the
// names it asked for and translates to the driver shape in one place.
type indexSpec struct {
	Keys       []string
	Directions []int
	Unique     bool
	Text       bool
	Partial    bool
	Name       string
}

// ingestIndexes is the SUBSET of the canonical index set (bootstrap.ts) that
// ingest correctness depends on: the worker must not start against a database
// where a redelivered message would be duplicated.
func ingestIndexes() map[string][]indexSpec {
	return map[string][]indexSpec{
		collMessages: {
			{Keys: []string{"organizationId", "instanceId", "waMessageId"}, Unique: true, Name: "uniq_message"},
			{Keys: []string{"organizationId", "instanceId", "groupJid", "flags.revoked", "timestamp", "waMessageId"}, Name: "memory_batch_scan"},
		},
		collGroups: {
			{Keys: []string{"organizationId", "instanceId", "groupJid"}, Unique: true, Name: "uniq_group"},
		},
		collSendRequests: {
			{Keys: []string{"status", "scheduledFor"}, Name: "send_due"},
		},
		collMemoryBatches: {
			{Keys: []string{"organizationId", "instanceId", "groupJid", "first.timestamp", "first.waMessageId", "last.timestamp", "last.waMessageId"}, Unique: true, Name: "uniq_memory_batch_range"},
			{Keys: []string{"organizationId", "instanceId", "groupJid", "predecessor"}, Unique: true, Partial: true, Name: "uniq_memory_batch_predecessor"},
			{Keys: []string{"organizationId", "state", "nextAttemptAt", "lease.expiresAt", "createdAt"}, Name: "memory_batch_claim"},
			{Keys: []string{"organizationId", "instanceId", "groupJid", "completedAt"}, Directions: []int{1, 1, 1, -1}, Name: "memory_batch_group_history"},
		},
		collMemorySummaries: {
			{Keys: []string{"organizationId", "batchId"}, Unique: true, Name: "uniq_memory_summary_batch"},
			{Keys: []string{"organizationId", "instanceId", "groupJid", "period.to"}, Directions: []int{1, 1, 1, -1}, Name: "memory_summary_recent"},
			{Keys: []string{"summary", "topics", "decisions", "openQuestions", "actionItems"}, Text: true, Name: "memory_summary_text"},
		},
		collMemoryFacts: {
			{Keys: []string{"organizationId", "batchId", "kind", "textSearch"}, Unique: true, Name: "uniq_memory_fact_in_batch"},
			{Keys: []string{"organizationId", "instanceId", "groupJid", "kind", "occurredAt"}, Directions: []int{1, 1, 1, 1, -1}, Name: "memory_fact_recent"},
			{Keys: []string{"text", "subject"}, Text: true, Name: "memory_fact_text"},
			{Keys: []string{"organizationId", "summaryId"}, Name: "memory_fact_summary"},
		},
		collAgentReplyRuns: {
			{Keys: []string{"organizationId", "instanceId", "groupJid", "waMessageId"}, Unique: true, Name: "uniq_agent_reply_source"},
			{Keys: []string{"organizationId", "state", "lease.expiresAt"}, Name: "agent_reply_recovery"},
		},
	}
}

func ensureIngestIndexes(ctx context.Context, db *mongo.Database) error {
	for coll, specs := range ingestIndexes() {
		models := make([]mongo.IndexModel, 0, len(specs))
		for _, spec := range specs {
			keys := make(bson.D, 0, len(spec.Keys))
			for i, key := range spec.Keys {
				if spec.Text {
					keys = append(keys, bson.E{Key: key, Value: "text"})
					continue
				}
				direction := 1
				if len(spec.Directions) > i {
					direction = spec.Directions[i]
				}
				keys = append(keys, bson.E{Key: key, Value: direction})
			}
			opts := options.Index().SetName(spec.Name)
			if spec.Unique {
				opts = opts.SetUnique(true)
			}
			if spec.Partial {
				opts = opts.SetPartialFilterExpression(bson.D{{Key: "predecessor", Value: bson.D{{Key: "$exists", Value: true}}}})
			}
			models = append(models, mongo.IndexModel{Keys: keys, Options: opts})
		}
		if _, err := db.Collection(coll).Indexes().CreateMany(ctx, models); err != nil {
			return fmt.Errorf("create %s indexes: %w", coll, err)
		}
	}
	return nil
}
