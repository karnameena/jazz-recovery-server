import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parsePhotoPayload, currentPhotoKey, shouldMigrateLegacyPhoto, writePhotoFile, readPhotoFile, deletePhotoFile } from "../src/pg/photos.mjs";

const jpegFixture = () => Buffer.from([0xff,0xd8,0xff,...Array(18).fill(0),0xff,0xd9]);
const pngFixture = () => Buffer.from([137,80,78,71,13,10,26,10,...Array(16).fill(0),0,0,0,0,73,69,78,68,174,66,96,130]);

test("photo payload accepts JPEG and PNG with matching MIME and intact boundaries", () => {
  assert.equal(parsePhotoPayload(jpegFixture().toString("base64"), "image/jpeg").mimeType, "image/jpeg");
  assert.equal(parsePhotoPayload(pngFixture().toString("base64"), "image/png").extension, "png");
});

test("photo payload rejects malformed, truncated, unsupported and MIME-mismatched data", () => {
  assert.throws(() => parsePhotoPayload("not base64!!!", "image/jpeg"));
  assert.throws(() => parsePhotoPayload(Buffer.from("GIF89a").toString("base64"), "image/gif"));
  assert.throws(() => parsePhotoPayload(Buffer.from([0xff,0xd8,0xff,...Array(18).fill(0)]).toString("base64"), "image/jpeg"));
  assert.throws(() => parsePhotoPayload(Buffer.from([137,80,78,71,13,10,26,10,...Array(16).fill(0)]).toString("base64"), "image/png"));
  assert.throws(() => parsePhotoPayload(jpegFixture().toString("base64"), "image/png"));
});

test("local photo files are written, read, and deleted without an external object-storage service", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-photo-test-"));
  process.env.JAZZ_PHOTO_DIR = root;
  try {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    const key = currentPhotoKey(7, id, "jpg");
    const bytes = jpegFixture();
    await writePhotoFile({ key, bytes, mimeType: "image/jpeg" });
    const loaded = await readPhotoFile(key);
    assert.deepEqual(Buffer.from(await loaded.Body.transformToByteArray()), bytes);
    assert.equal(loaded.ContentType, "image/jpeg");
    await deletePhotoFile(key);
    await assert.rejects(() => readPhotoFile(key), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("local photo path rejects traversal and invalid identities", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.match(currentPhotoKey(7, id, "jpg"), /^devices\/7\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/i);
  assert.throws(() => currentPhotoKey(0, id, "jpg"));
  assert.throws(() => currentPhotoKey(7, "../unsafe", "jpg"));
});

test("legacy data URL migrates only if no local current photo exists", () => {
  const dataUrl = "data:image/jpeg;base64,ZmFrZQ==";
  assert.equal(shouldMigrateLegacyPhoto({ photo_local_path: null, photo_data_url: dataUrl }, dataUrl), true);
  assert.equal(shouldMigrateLegacyPhoto({ photo_local_path: "devices/7/a/b.jpg", photo_data_url: dataUrl }, dataUrl), false);
  assert.equal(shouldMigrateLegacyPhoto({ photo_local_path: null, photo_data_url: "data:image/jpeg;base64,bmV3" }, dataUrl), false);
  assert.equal(shouldMigrateLegacyPhoto(null, dataUrl), false);
});
