import { GetObjectCommand, S3Client, type GetObjectCommandOutput } from "@aws-sdk/client-s3";
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
 *
 * The lifetime is returned with the URL rather than left to be guessed from the
 * signature: §2.2 invariant 8 says a URL is never reused past expiry, which the
 * surface holding it can only honour if it knows how long it has — and the
 * signed URL's own `X-Amz-Date` is the signer's clock, not the browser's.
 */
export interface PresignedMedia {
  url: string;
  expiresInSeconds: number;
}

export async function presignMediaUrl(key: string, organizationId: string): Promise<PresignedMedia> {
  if (!key.startsWith(`org/${organizationId}/`)) throw new ForeignMediaKeyError();
  const config = r2Config();
  const url = await getSignedUrl(
    getClient(config),
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn: config.ttlSeconds },
  );
  return { url, expiresInSeconds: config.ttlSeconds };
}

/**
 * Reads one stored object's bytes under the same organisation-prefix boundary
 * and the same validated client as a presign, with no URL in between: the agent
 * media tools must never receive a key, a URL, or a path to fetch themselves.
 *
 * `maxBytes` is the reading tool's own source cap. The declared length is
 * checked before the body is buffered and the stream is abandoned the moment it
 * exceeds the cap, so an oversized or hostile object cannot make the BFF
 * allocate without limit.
 *
 * `null` covers every way there is nothing to read — absent, empty, oversized,
 * or a failed fetch. The media tools answer one unavailable code for all of
 * them, so a probe cannot tell cross-tenant existence from a missing MIME.
 */
export async function readMediaObject(
  key: string,
  organizationId: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!key.startsWith(`org/${organizationId}/`)) throw new ForeignMediaKeyError();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
  const config = r2Config();
  let output: GetObjectCommandOutput;
  try {
    output = await getClient(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch {
    return null;
  }
  if (!output.Body) return null;
  // The Node client always answers with a readable stream; the Blob arm of the
  // SDK's union exists for the browser bundle this server never builds.
  const body = output.Body as unknown as AsyncIterable<Uint8Array> & { destroy: () => void };
  if (output.ContentLength !== undefined && output.ContentLength > maxBytes) {
    body.destroy();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > maxBytes) return null;
      chunks.push(chunk);
    }
  } catch {
    return null;
  } finally {
    body.destroy();
  }
  return total === 0 ? null : Buffer.concat(chunks);
}
