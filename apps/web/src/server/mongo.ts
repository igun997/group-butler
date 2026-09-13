import { MongoClient, type Db } from "mongodb";

export const DEFAULT_DB_NAME = "group_butler";

let cached: { client: MongoClient; db: Db } | null = null;

export function mongoConfig(): { uri: string; dbName: string } {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  return { uri, dbName: process.env.MONGODB_DB ?? DEFAULT_DB_NAME };
}

/** Process-wide pooled client (Next dev reloads reuse it). */
export async function getDb(): Promise<Db> {
  if (cached) return cached.db;
  const { uri, dbName } = mongoConfig();
  const client = new MongoClient(uri);
  await client.connect();
  cached = { client, db: client.db(dbName) };
  return cached.db;
}

export async function closeDb(): Promise<void> {
  await cached?.client.close();
  cached = null;
}

export async function connectForTest(uri: string, dbName = "butler_test") {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db(dbName) };
}
