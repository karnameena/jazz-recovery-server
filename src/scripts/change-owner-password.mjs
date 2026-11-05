import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { applyMigrations, db } from "../db/database.mjs";
import { hashSecret, validatePassword } from "../auth/password.mjs";

applyMigrations();

async function hiddenQuestion(prompt) {
  output.write(prompt);
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = readline.createInterface({ input, output });
    try { return await rl.question(""); } finally { rl.close(); }
  }
  return await new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
    };
    const onData = chunk => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") { cleanup(); reject(new Error("Cancelled.")); return; }
        if (char === "\r" || char === "\n") { cleanup(); resolve(value); return; }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        if (char >= " ") value += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

const rl = readline.createInterface({ input, output });
try {
  const username = (await rl.question("Lost Mode username: ")).trim();
  const user = db.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").get(username);
  if (!user) throw new Error("Owner not found.");
  rl.pause();

  const password = await hiddenQuestion("New password: ");
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  const confirm = await hiddenQuestion("Confirm new password: ");
  if (password !== confirm) throw new Error("Passwords do not match.");

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(hashSecret(password), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  console.log("Owner password changed. Existing browser sessions were invalidated.");
} finally {
  try { rl.close(); } catch {}
}
