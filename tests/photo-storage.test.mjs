import test from "node:test";
import assert from "node:assert/strict";
import { parsePhotoPayload, currentPhotoKey } from "../src/pg/photos.mjs";

const jpegFixture = () => Buffer.from([0xff,0xd8,0xff,...Array(18).fill(0),0xff,0xd9]);
const pngFixture = () => Buffer.from([
  137,80,78,71,13,10,26,10,
  ...Array(16).fill(0),
  0,0,0,0,73,69,78,68,174,66,96,130
]);

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

test("each photo upload attempt receives a unique object key", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  const first = currentPhotoKey(7, id, "jpg");
  const second = currentPhotoKey(7, id, "jpg");
  assert.match(first, /^devices\/7\/123e4567-e89b-12d3-a456-426614174000\/[0-9a-f-]{36}\.jpg$/i);
  assert.notEqual(first, second);
  assert.throws(() => currentPhotoKey(0, id, "jpg"));
  assert.throws(() => currentPhotoKey(7, "../unsafe", "jpg"));
});
