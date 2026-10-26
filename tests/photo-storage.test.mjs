import test from "node:test";
import assert from "node:assert/strict";
import { parsePhotoPayload } from "../src/pg/photos.mjs";

const jpegFixture = () => Buffer.from([0xff, 0xd8, 0xff, ...Array(18).fill(0), 0xff, 0xd9]);
const pngFixture = () => Buffer.from([137,80,78,71,13,10,26,10,...Array(16).fill(0),0,0,0,0,73,69,78,68,174,66,96,130]);

test("photo payload accepts JPEG and PNG with matching MIME and intact boundaries", () => {
  assert.deepEqual(parsePhotoPayload(jpegFixture().toString("base64"), "image/jpeg").bytes, jpegFixture());
  assert.equal(parsePhotoPayload(jpegFixture().toString("base64"), "image/jpeg").mimeType, "image/jpeg");
  assert.equal(parsePhotoPayload(pngFixture().toString("base64"), "image/png").mimeType, "image/png");
});

test("photo payload rejects malformed, truncated, unsupported and MIME-mismatched data", () => {
  assert.throws(() => parsePhotoPayload("not base64!!!", "image/jpeg"));
  assert.throws(() => parsePhotoPayload(Buffer.from("GIF89a").toString("base64"), "image/gif"));
  assert.throws(() => parsePhotoPayload(Buffer.from([0xff,0xd8,0xff,...Array(18).fill(0)]).toString("base64"), "image/jpeg"));
  assert.throws(() => parsePhotoPayload(Buffer.from([137,80,78,71,13,10,26,10,...Array(16).fill(0)]).toString("base64"), "image/png"));
  assert.throws(() => parsePhotoPayload(jpegFixture().toString("base64"), "image/png"));
});

test("photo payload enforces the 5 MB limit", () => {
  const tooLarge = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString("base64");
  assert.throws(() => parsePhotoPayload(tooLarge, "image/jpeg"));
});
