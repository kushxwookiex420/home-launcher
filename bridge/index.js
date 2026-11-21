// Freebuff bridge relay: the phone polls for commands, whoever holds the pairing code queues them
// and hands tasks to the coding agent. Nothing here executes anything on the phone — the launcher
// decides, against its own whitelist in MainActivity.runBridgeCommand.

const JSON_HEAD = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_FILE_CHARS = 200000;
const CODE_RE = /^[A-Z0-9]{6}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEAD });
}

function fail(status, message, code) {
  return json({ ok: false, error: message, code: code || httpCode(status) }, status);
}

function httpCode(status) {
  return (
    { 400: "bad_request", 401: "unauthorized", 404: "not_found", 405: "method_not_allowed",
      413: "too_large", 429: "rate_limited" }[status] || "error"
  );
}

function code6() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

const newId = () => crypto.randomUUID();
const iso = (ms) => new Date(ms).toISOString();

function ctEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanStr(value, max) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, max);
}

const ACTIONS = {
  status: { arg: "none" },
  page: { arg: "one", values: ["home", "mail", "ai", "apps", "money", "ent", "control"] },
  app: { arg: "text", max: 80 },
  torch: { arg: "one", values: ["on", "off"] },
  clear: { arg: "none" },
  remote: { arg: "text", max: 120 },
  url: { arg: "text", max: 600 }
};

const FILE_NAME_RE = /^[A-Za-z0-9._\-/]+$/;
const SECRET_NAME_RE = /(^|\/)(\.env[^/]*|id_rsa|id_ed25519|[^/]+\.(keystore|jks|pem|key|p12|pfx))$/i;

/** Returns an error message for a bad path, or null when the name is acceptable. */
function badFileName(raw) {
  if (typeof raw !== "string") return "name is required";
  const name = raw.trim();
  if (!name) return "name is required";
  if (name.length > 200) return "name must be 200 characters or fewer";
  if (name.includes("\\") || name.includes("\u0000") || name.startsWith("/")) return "invalid path";
  if (!FILE_NAME_RE.test(name)) return "name may only contain letters, numbers, dot, dash, underscore and /";
  const parts = name.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "invalid path";
  if (parts.some((p) => p.startsWith("."))) return "hidden files are not allowed";
  if (SECRET_NAME_RE.test(name)) return "this file type may not be shared";
  return null;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS bridges (
     id TEXT PRIMARY KEY,
     code TEXT UNIQUE NOT NULL,
     name TEXT,
     created_at INTEGER NOT NULL,
     last_seen INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS commands (
     id TEXT PRIMARY KEY,
     bridge_id TEXT NOT NULL,
     action TEXT NOT NULL,
     arg TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS notes (
     id TEXT PRIMARY KEY,
     bridge_id TEXT NOT NULL,
     source TEXT,
     text TEXT NOT NULL,
     ack INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS replies (
     id TEXT PRIMARY KEY,
     bridge_id TEXT NOT NULL,
     source TEXT,
     text TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS files (
     id TEXT PRIMARY KEY,
     bridge_id TEXT NOT NULL,
     name TEXT NOT NULL,
     mime TEXT,
     data TEXT NOT NULL,
     encoding TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS results (
     id TEXT PRIMARY KEY,
     bridge_id TEXT NOT NULL,
     command_id TEXT NOT NULL,
     output TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS hits (
     bridge_id TEXT NOT NULL,
     key TEXT NOT NULL,
     window INTEGER NOT NULL,
     count INTEGER NOT NULL,
     PRIMARY KEY (bridge_id, key)
   )`
];

// Columns added after the first schema shipped. D1 has no migrations, so each one is added only
// when PRAGMA says it is missing.
const COLUMNS = [
  ["notes", "done", "INTEGER NOT NULL DEFAULT 0"],
  ["notes", "title", "TEXT"],
  ["replies", "task_id", "TEXT"],
  ["replies", "artifacts", "TEXT"]
];

let schemaReady = null;

async function ensureColumn(db, table, column, ddl) {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all();
  const rows = info.results || [];
  if (!rows.some((r) => r.name === column)) {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  }
}

function ensureSchema(env) {
  if (!env.DB) return Promise.reject(new Error("DB binding missing"));
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const statement of DDL) await env.DB.prepare(statement).run();
      for (const [table, column, ddl] of COLUMNS) await ensureColumn(env.DB, table, column, ddl);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function readBody(request) {
  const text = await request.text();
  if (!text) return { body: {}, ok: true };
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return { body: {}, ok: false };
    return { body, ok: true };
  } catch {
    return { body: {}, ok: false };
  }
}

/** Resolves the device from the body, the query string or an Authorization: Bearer header. */
async function authDevice(request, env, url, body) {
  const header = request.headers.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const raw = body.code || url.searchParams.get("code") || bearer;
  if (!raw) return { error: fail(401, "pairing code required") };
  const code = String(raw).trim().toUpperCase();
  if (!CODE_RE.test(code)) return { error: fail(401, "malformed pairing code") };
  const row = await env.DB.prepare("SELECT id, code, name, last_seen FROM bridges WHERE code = ?")
    .bind(code)
    .first();
  if (!row || !ctEqual(row.code, code)) return { error: fail(401, "unknown pairing code") };
  return { device: row, code };
}

async function withinLimit(db, bridgeId, key, limit, windowMs, at) {
  const row = await db
    .prepare("SELECT window, count FROM hits WHERE bridge_id = ? AND key = ?")
    .bind(bridgeId, key)
    .first();
  if (!row || at - row.window >= windowMs) {
    await db
      .prepare("INSERT INTO hits (bridge_id, key, window, count) VALUES (?, ?, ?, 1) ON CONFLICT(bridge_id, key) DO UPDATE SET window = ?, count = 1")
      .bind(bridgeId, key, at, at)
      .run();
    return true;
  }
  if (row.count >= limit) return false;
  await db
    .prepare("UPDATE hits SET count = count + 1 WHERE bridge_id = ? AND key = ?")
    .bind(bridgeId, key)
    .run();
  return true;
}

function noteStatus(row) {
  if (row.done) return "done";
  if (row.ack) return "working";
  return "queued";
}

function parseArtifacts(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
