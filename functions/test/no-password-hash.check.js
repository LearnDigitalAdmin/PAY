/* Firestore user documents must never carry a password hash (Firebase Auth owns the password; devices keep their own local hash).
 * Run:  cd functions && node test/no-password-hash.check.js   (exit 1 on failure) */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "src");
const hits = [];
for (const f of fs.readdirSync(root, { recursive: true }).map(String).filter((n) => n.endsWith(".ts"))) {
  fs.readFileSync(path.join(root, f), "utf8").split("\n").forEach((line, i) => {
    if (/passwordHash|password_hash|@node-rs\/argon2/.test(line.replace(/\/\/.*$/, ""))) hits.push(`${f}:${i + 1}: ${line.trim()}`);
  });
}
if (hits.length) { console.error("  ✗ password hash referenced in functions/src:\n" + hits.join("\n")); process.exit(1); }
console.log("  ✓ no password hash is written or hashed in functions/src");
