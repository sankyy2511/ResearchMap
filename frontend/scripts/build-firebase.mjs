// Builds the web app as static files for Firebase Hosting (out/).
// Settings come from .env.firebase (copy .env.firebase.example). They are passed as real environment variables,
// so the development values in .env.local never end up in the live site.
// Run: npm run build:firebase   then   firebase deploy --only hosting
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../.env.firebase", import.meta.url));
if (!existsSync(file)) {
  console.error("Missing frontend/.env.firebase. Copy .env.firebase.example and fill in the backend address.");
  process.exit(1);
}
const env = { ...process.env, STATIC_EXPORT: "1" };
for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!/^https:\/\//.test(env.NEXT_PUBLIC_API_BASE_URL || "")) {
  console.error("NEXT_PUBLIC_API_BASE_URL in .env.firebase must be the https address of the backend, ending in /api/v1.");
  process.exit(1);
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const r = spawnSync(npm, ["run", "build"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(r.status ?? 1);
