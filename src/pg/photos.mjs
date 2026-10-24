import crypto from "node:crypto";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
let client;

export function parsePhotoPayload(imageBase64, declaredMimeType) {
  if (typeof imageBase64 !== "string" || imageBase64.length < 24 ||
      imageBase64.length > Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageBase64)) {
    throw new Error("Recovery photo is invalid or exceeds the 5 MB limit.");
  }
  const bytes = Buffer.from(imageBase64, "base64");
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES ||
      bytes.toString("base64") !== imageBase64) {
    throw new Error("Recovery photo encoding is invalid or exceeds the 5 MB limit.");
  }
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const mimeType = jpeg ? "image/jpeg" : png ? "image/png" : null;
  if (!mimeType || declaredMimeType !== mimeType) {
    throw new Error("Recovery photo must be a valid JPEG or PNG matching its declared content type.");
  }
  return { bytes, mimeType, extension: mimeType === "image/png" ? "png" : "jpg" };
}

export function photoStorageConfigured() {
  return Boolean(
    process.env.AWS_ENDPOINT_URL_S3 &&
    process.env.AWS_REGION &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY &&
    process.env.JAZZ_PHOTO_BUCKET
  );
}

function storageClient() {
  if (!photoStorageConfigured()) {
    throw new Error("Private photo storage is not configured. Set the Neon S3 endpoint, region, credentials and JAZZ_PHOTO_BUCKET.");
  }
  const endpoint = new URL(process.env.AWS_ENDPOINT_URL_S3);
  if (endpoint.protocol !== "https:") throw new Error("Private photo storage endpoint must use HTTPS.");
  if (!client) {
    client = new S3Client({
      endpoint: endpoint.toString().replace(/\/$/, ""),
      region: process.env.AWS_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    });
  }
  return client;
}

export function currentPhotoKey(deviceId, commandId, extension) {
  if (!Number.isSafeInteger(Number(deviceId)) || Number(deviceId) < 1 ||
      !/^[a-f0-9-]{36}$/i.test(String(commandId)) ||
      !["jpg", "png"].includes(extension)) {
    throw new Error("Invalid recovery photo object identity.");
  }
  return `devices/${Number(deviceId)}/${commandId}.${extension}`;
}

export async function uploadPhotoObject({ key, bytes, mimeType }) {
  const s3 = storageClient();
  await s3.send(new PutObjectCommand({
    Bucket: process.env.JAZZ_PHOTO_BUCKET,
    Key: key,
    Body: bytes,
    ContentLength: bytes.length,
    ContentType: mimeType,
    CacheControl: "private, no-store, max-age=0",
    Metadata: { purpose: "jazz-recovery-current-photo" }
  }));
  return key;
}

export async function signedPhotoUrl(key, { download = false } = {}) {
  if (typeof key !== "string" || !key.startsWith("devices/") || key.includes("..")) {
    throw new Error("Invalid current photo reference.");
  }
  const extension = key.endsWith(".png") ? "png" : "jpg";
  const command = new GetObjectCommand({
    Bucket: process.env.JAZZ_PHOTO_BUCKET,
    Key: key,
    ResponseContentType: extension === "png" ? "image/png" : "image/jpeg",
    ResponseCacheControl: "private, no-store, max-age=0",
    ResponseContentDisposition: `${download ? "attachment" : "inline"}; filename="jazz-recovery-current.${extension}"`
  });
  return getSignedUrl(storageClient(), command, { expiresIn: 300 });
}

export async function deletePhotoObject(key) {
  if (!key) return;
  await storageClient().send(new DeleteObjectCommand({
    Bucket: process.env.JAZZ_PHOTO_BUCKET,
    Key: key
  }));
}
