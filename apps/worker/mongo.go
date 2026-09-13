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
	collInstances      = "instances"
	collGroups         = "groups"
	collMessages       = "messages"
	collSendRequests   = "sendRequests"
	collAiCalls        = "aiCalls"
	collStatsDaily     = "statsDaily"
	collAuditLog       = "auditLog"
	collPairingSession = "pairingSessions"
	collAppSettings    = "appSettings"
	collOrganizations  = "organizations"
)

func connectMongo(ctx context.Context, uri, dbName string) (*mongo.Client, *mongo.Database, error) {
	client, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		return nil, nil, fmt.Errorf("mongo connect: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := client.Ping(pingCtx, nil); err != nil {
		return nil, nil, fmt.Errorf("mongo ping: %w", err)
	}
	return client, client.Database(dbName), nil
}

// indexSpec is a collection's index described by key names in order. The
// driver's IndexModel hides its keys behind `any`, so the worker keeps the
// names it asked for and translates to the driver shape in one place.
type indexSpec struct {
	Keys   []string
	Unique bool
	Name   string
}

// ingestIndexes is the SUBSET of the canonical index set (bootstrap.ts) that
// ingest correctness depends on: the worker must not start against a database
// where a redelivered message would be duplicated.
func ingestIndexes() map[string][]indexSpec {
	return map[string][]indexSpec{
		collMessages: {{
			Keys:   []string{"organizationId", "instanceId", "waMessageId"},
			Unique: true,
			Name:   "uniq_message",
		}},
		collGroups: {{
			Keys:   []string{"organizationId", "instanceId", "groupJid"},
			Unique: true,
			Name:   "uniq_group",
		}},
	}
}

func ensureIngestIndexes(ctx context.Context, db *mongo.Database) error {
	for coll, specs := range ingestIndexes() {
		models := make([]mongo.IndexModel, 0, len(specs))
		for _, spec := range specs {
			keys := make(bson.D, 0, len(spec.Keys))
			for _, key := range spec.Keys {
				keys = append(keys, bson.E{Key: key, Value: 1})
			}
			opts := options.Index().SetName(spec.Name)
			if spec.Unique {
				opts = opts.SetUnique(true)
			}
			models = append(models, mongo.IndexModel{Keys: keys, Options: opts})
		}
		if _, err := db.Collection(coll).Indexes().CreateMany(ctx, models); err != nil {
			return fmt.Errorf("create %s indexes: %w", coll, err)
		}
	}
	return nil
}
