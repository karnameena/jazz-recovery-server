import crypto from "node:crypto";

const TOKEN_TTL_MS = 120_000;
const MAX_ENCOUNTER_AGE_MS = 120_000;
const MAX_LOCATION_AGE_MS = 900_000;

function tokenHash(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function validCoordinate(value, min, max) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }

export async function handleHelperLocationRoute({ req, res, path, json, readJson, authenticateDevice, requireSession, ownerDevice, db, audit, sqliteUtcToIso }) {
  if (req.method === "POST" && path === "/android/device/beacon") {
    const device = await authenticateDevice(req);
    if (!device) { json(req, res, 401, { ok: false, error: "Unauthorized device" }); return true; }
    const state = await db.prepare("SELECT mode FROM device_state WHERE device_id=?").get(device.id);
    if (state?.mode !== "LOST_MODE") { json(req, res, 409, { ok: false, error: "Lost Mode must be active on the server before issuing a beacon" }); return true; }
    const raw = crypto.randomBytes(10).toString("base64url");
    const hash = tokenHash(raw);
    const now = Date.now();
    const expiresAt = now + TOKEN_TTL_MS;
    await db.prepare("DELETE FROM recovery_beacon_tokens WHERE device_id=? OR expires_at<CURRENT_TIMESTAMP").run(device.id);
    await db.prepare("INSERT INTO recovery_beacon_tokens(token_hash,device_id,expires_at) VALUES(?,?,?)")
      .run(hash, device.id, new Date(expiresAt).toISOString());
    return json(req, res, 200, { ok: true, beaconToken: raw, expiresAt, serviceUuid: "b5b3c0a1-7c9e-4d12-9f40-4a415a5a5a01" }), true;
  }

  if (req.method === "POST" && path === "/android/helper/encounters") {
    const helper = await authenticateDevice(req);
    if (!helper) { json(req, res, 401, { ok: false, error: "Unauthorized helper device" }); return true; }
    const body = await readJson(req, 16 * 1024);
    const beaconToken = String(body.beaconToken || "");
    const encounterId = String(body.encounterId || "");
    const observedAt = Number(body.observedAt);
    const locationTimestamp = Number(body.locationTimestamp);
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const accuracy = body.accuracyMeters == null ? null : Number(body.accuracyMeters);
    const now = Date.now();
    if (!/^[A-Za-z0-9_-]{14}$/.test(beaconToken) || !/^[0-9a-f-]{36}$/i.test(encounterId) ||
        !Number.isSafeInteger(observedAt) || Math.abs(now - observedAt) > MAX_ENCOUNTER_AGE_MS ||
        !Number.isSafeInteger(locationTimestamp) || locationTimestamp > now + 30_000 || now - locationTimestamp > MAX_LOCATION_AGE_MS ||
        !validCoordinate(latitude, -90, 90) || !validCoordinate(longitude, -180, 180) ||
        (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 10000))) {
      json(req, res, 400, { ok: false, error: "Invalid or stale helper encounter" }); return true;
    }
    const beacon = await db.prepare("SELECT device_id FROM recovery_beacon_tokens WHERE token_hash=? AND expires_at>CURRENT_TIMESTAMP")
      .get(tokenHash(beaconToken));
    if (!beacon) { json(req, res, 410, { ok: false, error: "Recovery beacon expired or unknown" }); return true; }
    if (Number(beacon.device_id) === Number(helper.id)) { json(req, res, 400, { ok: false, error: "A device cannot report itself as a helper encounter" }); return true; }
    try {
      await db.prepare(`INSERT INTO recovery_helper_encounters(encounter_id,target_device_id,helper_device_id,latitude,longitude,accuracy_meters,location_timestamp,observed_at,location_source,location_fresh)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(encounterId, beacon.device_id, helper.id, latitude, longitude, accuracy, locationTimestamp, observedAt,
          String(body.locationSource || "phone_b_fused").slice(0, 40), body.locationFresh === true && now - locationTimestamp <= 30_000);
    } catch (error) {
      if (error?.code === "23505") { json(req, res, 409, { ok: false, error: "Encounter already reported" }); return true; }
      throw error;
    }
    const target = await db.prepare("SELECT user_id FROM devices WHERE id=?").get(beacon.device_id);
    await audit(target?.user_id ?? null, beacon.device_id, "BLUETOOTH_HELPER_ENCOUNTER", "RECEIVED");
    return json(req, res, 201, { ok: true, status: "RECEIVED", targetDeviceId: beacon.device_id, observedAt }), true;
  }

  const ownerMatch = path.match(/^\/api\/devices\/(\d+)\/helper-locations$/);
  if (req.method === "GET" && ownerMatch) {
    const session = await requireSession(req, res); if (!session) return true;
    const row = await ownerDevice(session.user_id, ownerMatch[1]);
    if (!row) { json(req, res, 404, { ok: false, error: "Device not found" }); return true; }
    const items = await db.prepare(`SELECT e.encounter_id AS id,e.latitude,e.longitude,e.accuracy_meters AS "accuracyMeters",
      e.location_timestamp AS "locationTimestamp",e.observed_at AS "observedAt",e.location_source AS "locationSource",
      e.location_fresh AS "locationFresh",e.received_at AS "receivedAt",h.device_name AS "helperDeviceName"
      FROM recovery_helper_encounters e JOIN devices h ON h.id=e.helper_device_id
      WHERE e.target_device_id=? ORDER BY e.received_at DESC LIMIT 25`).all(row.id);
    const now = Date.now();
    const normalized = items.map(item => {
      const ageMs = now - Number(item.locationTimestamp);
      const validAge = Number.isFinite(ageMs) && ageMs >= 0;
      return { ...item,
        receivedAt: sqliteUtcToIso(item.receivedAt),
        ageMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : null,
        freshness: validAge && ageMs <= 30_000 ? "FRESH_HELPER_REPORT" :
          validAge && ageMs <= 900_000 ? "RECENT_HELPER_REPORT" : "STALE_HELPER_REPORT",
        locationType: "HELPER_PHONE_LOCATION_ESTIMATE"
      };
    });
    return json(req, res, 200, { ok: true, locationType: "HELPER_PHONE_LOCATION_ESTIMATE", items: normalized }), true;
  }
  return false;
}
