import test from "node:test";
import assert from "node:assert/strict";
import { parsePhotoPayload, currentPhotoKey } from "../src/pg/photos.mjs";

test("photo payload accepts JPEG and PNG signatures with matching MIME", () => {
  const jpeg = Buffer.from([0xff,0xd8,0xff,...Array(18).fill(0)]);
  const png = Buffer.from([137,80,78,71,13,10,26,10,...Array(16).fill(0)]);
  assert.equal(parsePhotoPayload(jpeg.toString("base64"), "image/jpeg").mimeType, "image/jpeg");
  assert.equal(parsePhotoPayload(png.toString("base64"), "image/png").extension, "png");
});

test("photo payload rejects malformed base64, unsupported types and mismatched MIME", () => {
  assert.throws(() => parsePhotoPayload("not base64!!!", "image/jpeg"));
  assert.throws(() => parsePhotoPayload(Buffer.from("GIF89a").toString("base64"), "image/gif"));
  assert.throws(() => parsePhotoPayload(Buffer.from([0xff,0xd8,0xff,...Array(18).fill(0)]).toString("base64"), "image/png"));
});

test("current photo object keys are deterministic per device and command", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(currentPhotoKey(7, id, "jpg"), `devices/7/${id}.jpg`);
  assert.throws(() => currentPhotoKey(0, id, "jpg"));
  assert.throws(() => currentPhotoKey(7, "../unsafe", "jpg"));
});
