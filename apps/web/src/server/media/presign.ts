import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * A stored key that does not belong to the session's organisation. It is thrown
 * before any credential is touched, so it stays a boundary the caller can act
 * on rather than an opaque signing failure.
 */
export class ForeignMediaKeyError extends Error {
  constructor() {
    super("key outside organisation prefix");
    this.name = "ForeignMediaKeyError";
  }
}

let client: S3Client | null = null;

/** The only endpoint this project can ever use: the account-scoped R2 host. */
export function r2Endpoint(accountId: string | undefined): string {
  return accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "";
}

function s3(): S3Client {
  if (client) return client;
  const endpoint = r2Endpoint(process.env.R2_ACCOUNT_ID);
  if (!endpoint) throw new Error("R2_ACCOUNT_ID is required to presign media");
  client = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    },
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
 */
export async function presignMediaUrl(key: string, organizationId: string): Promise<string> {
  if (!key.startsWith(`org/${organizationId}/`)) throw new ForeignMediaKeyError();
  const ttl = Number(process.env.R2_PRESIGN_TTL_SECONDS ?? 300);
  return getSignedUrl(
    s3(),
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET ?? "group-butler", Key: key }),
    { expiresIn: ttl },
  );
}
