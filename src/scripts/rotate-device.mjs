import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { applyMigrations, db } from "../db/database.mjs";
import { hashSecret, randomToken } from "../auth/password.mjs";

applyMigrations();

const rl = readline.createInterface({ input, output });
try {
  const username = (await rl.question("Owner username: ")).trim();
  const user = db.prepare("SELECT id,username FROM users WHERE username=? COLLATE NOCASE").get(username);
  if (!user) throw new Error("Owner not found.");

  const deviceId = (await rl.question("Existing Device ID: ")).trim();
  if (!deviceId) throw new Error("Device ID is required.");

  const device = db.prepare("SELECT id,device_id,device_name FROM devices WHERE user_id=? AND device_id=?").get(user.id, deviceId);
  if (!device) throw new Error("Device not found for this owner.");

  const token = randomToken(32);
  db.prepare("UPDATE devices SET credential_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(hashSecret(token), device.id);

  db.prepare("INSERT INTO recovery_audit(user_id,device_id,action,status) VALUES(?,?,?,?)")
    .run(user.id, device.id, "ROTATE_DEVICE_CREDENTIAL", "SUCCESS");

  console.log("\nDevice credential rotated successfully.");
  console.log(`Device ID: ${device.device_id}`);
  console.log(`Device name: ${device.device_name}`);
  console.log(`NEW device credential (shown once): ${token}`);
  console.log("The previous credential is now invalid. Update only the Android Companion Lost Mode configuration.");
} finally {
  rl.close();
}
