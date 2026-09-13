import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * A stored key that does not belong to the session's organisation. It is thrown
 * before any configuration is read or credential touched, so it stays a
 * boundary the caller can act on rather than an opaque signing failure.
 */
export class ForeignMediaKeyError extends Error {
  constructor() {
    super("key outside organisation prefix");
    this.name = "ForeignMediaKeyError";
  }
}

/**
 * The server's R2 configuration is missing or invalid. It never reaches the
 * caller verbatim — the media route answers a safe 503 — and it means the
 * deployment is wrong, not the request.
 */
export class R2ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "R2ConfigurationError";
  }
}

/**
 * The signed-URL ceiling AWS SigV4 accepts (7 days). A TTL is validated against
 * it before signing, so no configuration can mint a URL that outlives the
 * bucket's intended read window.
 */
export const MAX_PRESIGN_TTL_SECONDS = 604800;

interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  ttlSeconds: number;
}

let client: S3Client | null = null;

/** The only endpoint this project can ever use: the account-scoped R2 host. */
export function r2Endpoint(accountId: string | undefined): string {
  return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "";
}

/** A required setting, refused when unset or blank — never a silent default. */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new R2ConfigurationError(`${name} is required to presign media`);
  return value;
}

/**
 * Reads and validates every value a signature depends on. There is no default
 * bucket and no empty credential: an incomplete deployment fails closed here,
 * before `getSignedUrl` ever runs.
 */
function r2Config(): R2Config {
  const accountId = required("R2_ACCOUNT_ID");
  const bucket = required("R2_BUCKET");
  const accessKeyId = required("R2_ACCESS_KEY_ID");
  const secretAccessKey = required("R2_SECRET_ACCESS_KEY");

  const ttlSeconds = Number(required("R2_PRESIGN_TTL_SECONDS"));
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_PRESIGN_TTL_SECONDS) {
    throw new R2ConfigurationError(
      `R2_PRESIGN_TTL_SECONDS must be an integer between 1 and ${MAX_PRESIGN_TTL_SECONDS}`,
    );
  }

  return { accountId, bucket, accessKeyId, secretAccessKey, ttlSeconds };
}

/** Process-wide client; the validated config is what it was built from. */
function getClient(config: R2Config): S3Client {
  if (client) return client;
  client = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(config.accountId),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return client;
}

/**
 * Media is private; access is a short-lived presigned GET (§11.4). The bucket
 * stays private and the TTL is minutes, so a leaked URL expires rather than
 * granting standing access.
 *
 * The organisation is the caller's session organisation, never a process
 * default: a key is signed only when it sits under `org/<session org>/`, so a
 * row pointing at another tenant's object can never be handed back as a URL.
 * The tenant check comes first; only then is configuration read and validated.
 */
export async function presignMediaUrl(key: string, organizationId: string): Promise<string> {
  if (!key.startsWith(`org/${organizationId}/`)) throw new ForeignMediaKeyError();
  const config = r2Config();
  return getSignedUrl(
    getClient(config),
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn: config.ttlSeconds },
  );
}
