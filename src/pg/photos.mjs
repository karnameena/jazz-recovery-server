import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MIME_BY_EXTENSION = { jpg: "image/jpeg", png: "image/png" };

function photoRoot() {
  const configured = String(process.env.JAZZ_PHOTO_DIR || "").trim();
  if (process.env.NODE_ENV === "production" && !configured) {
    throw new Error("JAZZ_PHOTO_DIR must point to a persistent local directory in production.");
  }
  return path.resolve(configured || path.join(process.cwd(), "var", "photos"));
}

function safeRelativeKey(key) {
  if (typeof key !== "string" || key.includes("\\") || key.startsWith("/") ||
      key.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Invalid current recovery photo path.");
  }
  const parts = key.split("/");
  if (parts.length !== 4 || parts[0] !== "devices" ||
      !/^\d+$/.test(parts[1]) || !/^[a-f0-9-]{36}$/i.test(parts[2]) ||
      !/^[a-f0-9-]{36}\.(?:jpg|png)$/i.test(parts[3])) {
    throw new Error("Invalid current recovery photo path.");
  }
  return key;
}

function absolutePhotoPath(key) {
  const root = photoRoot();
  const target = path.resolve(root, safeRelativeKey(key));
  if (!target.startsWith(root + path.sep)) throw new Error("Invalid current recovery photo path.");
  return target;
}

export function parsePhotoPayload(imageBase64, declaredMimeType) {
  if (typeof imageBase64 !== "string" || imageBase64.length < 24 ||
      imageBase64.length > Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(imageBase64)) {
    throw new Error("Recovery photo is invalid or exceeds the 5 MB limit.");
  }
  const bytes = Buffer.from(imageBase64, "base64");
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES || bytes.toString("base64") !== imageBase64) {
    throw new Error("Recovery photo encoding is invalid or exceeds the 5 MB limit.");
  }
  const jpeg = bytes.length >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  const pngSignature = Buffer.from([137,80,78,71,13,10,26,10]);
  const pngEnd = Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]);
  const png = bytes.length >= 20 && bytes.subarray(0,8).equals(pngSignature) &&
    bytes.subarray(bytes.length - 12).equals(pngEnd);
  const mimeType = jpeg ? "image/jpeg" : png ? "image/png" : null;
  if (!mimeType || declaredMimeType !== mimeType) {
    throw new Error("Recovery photo must be a valid JPEG or PNG matching its declared content type.");
  }
  return { bytes, mimeType, extension: mimeType === "image/png" ? "png" : "jpg" };
}

export function shouldMigrateLegacyPhoto(currentState, legacyDataUrl) {
  return Boolean(currentState && !currentState.photo_local_path &&
    typeof legacyDataUrl === "string" && legacyDataUrl.length > 0 &&
    currentState.photo_data_url === legacyDataUrl);
}

export function localPhotoStorageReady() {
  try { photoRoot(); return true; } catch { return false; }
}

export function currentPhotoKey(deviceId, commandId, extension) {
  if (!Number.isSafeInteger(Number(deviceId)) || Number(deviceId) < 1 ||
      !/^[a-f0-9-]{36}$/i.test(String(commandId)) || !["jpg", "png"].includes(extension)) {
    throw new Error("Invalid recovery photo file identity.");
  }
  return `devices/${Number(deviceId)}/${commandId}/${crypto.randomUUID()}.${extension}`;
}

export async function writePhotoFile({ key, bytes, mimeType }) {
  const target = absolutePhotoPath(key);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_PHOTO_BYTES ||
      !Object.values(MIME_BY_EXTENSION).includes(mimeType) ||
      MIME_BY_EXTENSION[path.extname(target).slice(1)] !== mimeType) {
    throw new Error("Recovery photo bytes or content type are invalid.");
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = target + "." + crypto.randomUUID() + ".tmp";
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return key;
}

export async function readPhotoFile(key) {
  const target = absolutePhotoPath(key);
  const bytes = await fs.readFile(target);
  if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) throw new Error("Current photo file size is invalid.");
  const mimeType = MIME_BY_EXTENSION[path.extname(target).slice(1)];
  return { Body: { transformToByteArray: async () => new Uint8Array(bytes) }, ContentType: mimeType, bytes, mimeType };
}

export async function deletePhotoFile(key) {
  if (!key) return;
  await fs.rm(absolutePhotoPath(key), { force: true });
}

export async function localPhotoUrl(key, { download = false } = {}) {
  const safeKey = safeRelativeKey(key);
  const deviceId = safeKey.split("/")[1];
  return `/api/devices/${deviceId}/photo-content${download ? "?download=1" : ""}`;
}
