/**
 * The collection names shared by the BFF and the worker, mirrored in
 * `apps/worker/mongo.go`. They are plain strings because `organizationId` is a
 * plain string on every document — the tenancy boundary is not a foreign key.
 */
export const COLLECTIONS = {
  organizations: "organizations",
  instances: "instances",
  pairingSessions: "pairingSessions",
  groups: "groups",
  messages: "messages",
  sendRequests: "sendRequests",
  aiCalls: "aiCalls",
  statsDaily: "statsDaily",
  auditLog: "auditLog",
  appSettings: "appSettings",
  streamCursors: "streamCursors",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
