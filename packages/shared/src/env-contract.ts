/**
 * Every environment variable the BFF or the worker reads at runtime.
 *
 * `scripts/dev.sh` sources the root `.env`, and the test beside this file fails
 * if a key is added here without appearing in `.env.example` — that is how a new
 * variable cannot silently land in code without a documented value.
 *
 * Object storage is Cloudflare R2, the real service, in every environment. The
 * endpoint is derived from `R2_ACCOUNT_ID` in code
 * (`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`), so there is deliberately
 * no endpoint variable: no override, no emulator, no path-style configuration.
 */
export const REQUIRED_ENV = [
  // --- tenancy and storage backend ---
  "ORGANIZATION_ID",
  // Country the operator omits when typing their own number in national form.
  "DEFAULT_COUNTRY_CODE",
  "MONGODB_URI",
  "MONGODB_DB",
  "LOG_LEVEL",
  "ENVIRONMENT",

  // --- worker control plane ---
  "PORT",
  "WORKER_URL",
  "WORKER_SECRET",
  "WHATSMEOW_DB_URI",

  // --- object storage: Cloudflare R2 (real service; endpoint derived) ---
  "R2_ACCOUNT_ID",
  "R2_BUCKET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_PUBLIC_URL",
  "R2_PRESIGN_TTL_SECONDS",

  // --- dashboard owner auth (one owner account) ---
  "OWNER_EMAIL",
  "OWNER_PASSWORD",
  "OWNER_PASSWORD_HASH",
  "AUTH_SECRET",
  "LOGIN_RATE_LIMIT",
  "TRUSTED_PROXY_HOPS",

  // --- AI provider ---
  "AI_BASE_URL",
  "AI_API_KEY",
  "AI_MODEL",
  "AI_MAX_TOKENS_PER_DAY",


  // --- agent memory batches ---
  "MEMORY_BATCH_INTERVAL",
  "MEMORY_BATCH_CONCURRENCY",
  "MEMORY_CALLBACK_URL",
  "MEMORY_CALLBACK_SECRET",
  // --- worker ingest ---
  "INGEST_QUEUE_SIZE",
  "INGEST_FLUSH_MS",
  "INGEST_FLUSH_MAX",
  "RAW_JSON_MAX_BYTES",
  "RAW_SEARCH_MAX_BYTES",

  // --- worker media ---
  "MEDIA_MAX_BYTES",
  "MEDIA_CONCURRENCY",
  "MEDIA_DOWNLOAD_TIMEOUT",
  "MEDIA_MAX_ATTEMPTS",
  "MEDIA_JANITOR_INTERVAL",
  "MEDIA_ENRICH_ENABLED",
  "HISTORY_SYNC_MAX_DAYS",
  "RETENTION_MESSAGES_DAYS",

  // --- group discovery and sync ---
  "GROUP_SYNC_INTERVAL",
  "GROUP_STALE_AFTER",
  "GROUP_SYNC_PRUNE",

  // --- sends and dispatch ---
  "DISPATCH_INTERVAL",
  "SEND_MAX_ATTEMPTS",

  // --- live updates: SSE is the default, this is the polling fallback ---
  "STREAM_POLL_MS",
] as const;

export type RequiredEnvKey = (typeof REQUIRED_ENV)[number];
