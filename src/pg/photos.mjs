const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

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
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const pngEnd = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  const png = bytes.length >= 20 && bytes.subarray(0, 8).equals(pngSignature) &&
    bytes.subarray(bytes.length - 12).equals(pngEnd);
  const mimeType = jpeg ? "image/jpeg" : png ? "image/png" : null;
  if (!mimeType || declaredMimeType !== mimeType) {
    throw new Error("Recovery photo must be a valid JPEG or PNG matching its declared content type.");
  }
  return { bytes, mimeType };
}
