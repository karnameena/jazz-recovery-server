import fs from "node:fs";
import path from "node:path";
const file = path.resolve(process.argv[2] || "src/pg/server.mjs");
let s = fs.readFileSync(file, "utf8");
if (!s.includes('from "./helper-location.mjs"')) {
  const importAnchor = 'import crypto from "node:crypto";';
  if (!s.includes(importAnchor)) throw new Error("Could not find crypto import in server.mjs; no changes made.");
  s = s.replace(importAnchor, importAnchor + '\nimport { handleHelperLocationRoute } from "./helper-location.mjs";');
}
const routeAnchor = '    if (req.method === "GET" && path === "/") {';
if (!s.includes("handleHelperLocationRoute({ req, res, path")) {
  if (!s.includes(routeAnchor)) throw new Error("Could not find request-dispatch anchor in server.mjs; no changes made.");
  const call = `    if (await handleHelperLocationRoute({ req, res, path, json, readJson, authenticateDevice, requireSession, ownerDevice, db, audit, sqliteUtcToIso })) return;\n\n`;
  s = s.replace(routeAnchor, call + routeAnchor);
}
fs.writeFileSync(file, s, "utf8");
console.log("Installed helper-location routes in " + file);
