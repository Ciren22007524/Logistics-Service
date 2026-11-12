import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../config.js';

let internal: S3Client | undefined;
let publicClient: S3Client | undefined;

function make(endpoint: string): S3Client {
  const c = config();
  return new S3Client({
    endpoint,
    region: c.S3_REGION,
    forcePathStyle: c.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY },
  });
}

function s3(): S3Client {
  internal ??= make(config().S3_ENDPOINT);
  return internal;
}

function s3Public(): S3Client {
  publicClient ??= make(config().S3_PUBLIC_ENDPOINT ?? config().S3_ENDPOINT);
  return publicClient;
}

export async function ensureBucket(): Promise<void> {
  const Bucket = config().S3_BUCKET;
  try {
    await s3().send(new HeadBucketCommand({ Bucket }));
  } catch {
    await s3().send(new CreateBucketCommand({ Bucket }));
  }
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({ Bucket: config().S3_BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function getObject(key: string): Promise<Uint8Array> {
  const res = await s3().send(new GetObjectCommand({ Bucket: config().S3_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`empty object ${key}`);
  return res.Body.transformToByteArray();
}

/** 標籤一律短效簽名網址（規格 9.3） */
export async function signedUrl(key: string, ttlSeconds = config().LABEL_URL_TTL_SECONDS): Promise<string> {
  return getSignedUrl(s3Public(), new GetObjectCommand({ Bucket: config().S3_BUCKET, Key: key }), {
    expiresIn: ttlSeconds,
  });
}
