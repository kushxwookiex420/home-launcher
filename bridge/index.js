// Freebuff bridge relay: the phone polls for commands, assistant and agent credentials queue them
// and hand tasks across. Nothing here executes anything on the phone — the launcher decides,
// against its own whitelist in MainActivity.runBridgeCommand.
//
// Credentials:
//   hb_ax_…    Ax role: submit tasks, read replies/status, read files, queue approved phone actions
//   hb_buff_…  Buff role: claim tasks, reply, upload/update artifacts, read files
//   code       owner: the phone pairing code, still accepted for the installed APK and for key
//              management. Never stored in this repo.
// Every token is stored only as a SHA-256 hash; the plaintext is shown once at creation.

import { OPENAPI } from "./openapi.js";

const JSON_HEAD = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_FILE_CHARS = 200000;
const CODE_RE = /^[A-Z0-9]{6}$/;
const TOKEN_RE = /^hb_(ax|buff)_[0-9a-f]{48}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEAD });
}

function fail(status, message, code) {
  return json({ ok: false, error: message, code: code || httpCode(status) }, status);
}

function httpCode(status) {
  return (
    { 400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found",
      405: "method_not_allowed", 413: "too_large", 429: "rate_limited" }[status] || "error"
  );
}

function code6() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function token(role) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `hb_${role}_${hex}`;
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
   )`,
  `CREATE TABLE IF NOT EXISTS keys (
     id TEXT PRIMARY KEY,
     bridge_id TEXT NOT NULL,
     role TEXT NOT NULL,
     label TEXT,
     hash TEXT NOT NULL UNIQUE,
     prefix TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER,
     revoked_at INTEGER,
     last_used INTEGER
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

/**
 * Resolves the caller. A Bearer token picks the role from the keys table; the pairing code (Bearer,
 * body or query, for the installed phone app) resolves to the owner role.
 */
async function authenticate(request, env, url, body) {
  const header = request.headers.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const now = Date.now();

  if (TOKEN_RE.test(bearer)) {
    const hash = await sha256(bearer);
    const row = await env.DB.prepare(
      "SELECT id, bridge_id, role, label, expires_at, revoked_at, last_used FROM keys WHERE hash = ?"
    ).bind(hash).first();
    if (!row) return { error: fail(401, "unknown credential") };
    if (row.revoked_at) return { error: fail(401, "credential revoked") };
    if (row.expires_at && now > row.expires_at) return { error: fail(401, "credential expired") };
    const device = await env.DB.prepare("SELECT id, code, name, last_seen FROM bridges WHERE id = ?")
      .bind(row.bridge_id)
      .first();
    if (!device) return { error: fail(401, "credential is not attached to a phone") };
    if (!row.last_used || now - row.last_used > 60000) {
      await env.DB.prepare("UPDATE keys SET last_used = ? WHERE id = ?").bind(now, row.id).run();
    }
    return {
      principal: {
        role: row.role,
        device,
        deviceId: device.id,
        keyId: row.id,
        label: row.label,
        rateKey: `k:${row.id}`
      }
    };
  }

  if (bearer && !CODE_RE.test(bearer.toUpperCase())) {
    return { error: fail(401, "unrecognized credential format") };
  }

  const raw = bearer || body.code || url.searchParams.get("code");
  if (!raw) return { error: fail(401, "credential required") };
  const code = String(raw).trim().toUpperCase();
  if (!CODE_RE.test(code)) return { error: fail(401, "malformed pairing code") };
  const device = await env.DB.prepare("SELECT id, code, name, last_seen FROM bridges WHERE code = ?")
    .bind(code)
    .first();
  if (!device || !ctEqual(device.code, code)) return { error: fail(401, "unknown pairing code") };
  return { principal: { role: "owner", device, deviceId: device.id, keyId: null, rateKey: `c:${device.id}` } };
}

function allowed(principal, roles) {
  return principal.role === "owner" || roles.includes(principal.role);
}

function forbidden(principal, why) {
  return fail(403, `${why} (credential role: ${principal.role})`, "forbidden");
}

async function withinLimit(db, rateKey, key, limit, windowMs, at) {
  const row = await db
    .prepare("SELECT window, count FROM hits WHERE bridge_id = ? AND key = ?")
    .bind(rateKey, key)
    .first();
  if (!row || at - row.window >= windowMs) {
    await db
      .prepare("INSERT INTO hits (bridge_id, key, window, count) VALUES (?, ?, ?, 1) ON CONFLICT(bridge_id, key) DO UPDATE SET window = ?, count = 1")
      .bind(rateKey, key, at, at)
      .run();
    return true;
  }
  if (row.count >= limit) return false;
  await db
    .prepare("UPDATE hits SET count = count + 1 WHERE bridge_id = ? AND key = ?")
    .bind(rateKey, key)
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

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      const message = String((error && error.message) || error);
      return fail(500, message, "internal");
    }
  }
};

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (method === "GET" && path === "/health") {
    try {
      await ensureSchema(env);
      return json({ ok: true, db: !!env.DB });
    } catch (error) {
      return fail(500, String((error && error.message) || error), "db");
    }
  }

  if (method === "GET" && path === "/openapi.json") return json(OPENAPI);

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEAD });

  await ensureSchema(env);
  const db = env.DB;
  const now = Date.now();
  const parsed = method === "POST" ? await readBody(request) : { body: {}, ok: true };
  if (method === "POST" && !parsed.ok) return fail(400, "invalid json");

  // ---- phone endpoints (unchanged contract: the sideloaded APK talks to these) ----

  if (method === "POST" && path === "/bridge") {
    const body = parsed.body;
    const id = newId();
    let code = code6();
    for (let attempt = 0; attempt < 4; attempt++) {
      const clash = await db.prepare("SELECT id FROM bridges WHERE code = ?").bind(code).first();
      if (!clash) break;
      code = code6();
    }
    await db
      .prepare("INSERT INTO bridges (id, code, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)")
      .bind(id, code, cleanStr(body.name, 40) || "phone", now, now)
      .run();
    return json({ id, code });
  }

  if (method === "POST" && path === "/poll") {
    const body = parsed.body;
    const bridge = await db
      .prepare("SELECT id FROM bridges WHERE id = ? AND code = ?")
      .bind(cleanStr(body.id, 60), String(body.code || "").trim().toUpperCase())
      .first();
    if (!bridge) return fail(404, "unknown bridge");
    await db.prepare("UPDATE bridges SET last_seen = ? WHERE id = ?").bind(now, bridge.id).run();
    const command = await db
      .prepare("SELECT id, action, arg FROM commands WHERE bridge_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1")
      .bind(bridge.id)
      .first();
    if (!command) return json({ command: null });
    await db.prepare("UPDATE commands SET status = 'taken' WHERE id = ?").bind(command.id).run();
    return json({ command });
  }

  if (method === "POST" && path === "/result") {
    const body = parsed.body;
    const bridge = await db
      .prepare("SELECT id FROM bridges WHERE id = ? AND code = ?")
      .bind(cleanStr(body.id, 60), String(body.code || "").trim().toUpperCase())
      .first();
    if (!bridge) return fail(404, "unknown bridge");
    const commandId = cleanStr(body.commandId, 60);
    if (!commandId) return fail(400, "commandId required");
    await db.prepare("UPDATE commands SET status = 'done' WHERE id = ? AND bridge_id = ?").bind(commandId, bridge.id).run();
    await db
      .prepare("INSERT INTO results (id, bridge_id, command_id, output, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(newId(), bridge.id, commandId, cleanStr(body.output, 800), now)
      .run();
    return json({ ok: true });
  }

  // ---- authenticated endpoints ----

  const auth = await authenticate(request, env, url, parsed.body);
  if (auth.error) return auth.error;
  const principal = auth.principal;
  const device = principal.device;

  if (method === "POST" && path === "/keys") {
    if (principal.role !== "owner") return forbidden(principal, "only the owner pairing code may mint credentials");
    const body = parsed.body;
    const role = cleanStr(body.role, 10).toLowerCase();
    if (role !== "ax" && role !== "buff") return fail(400, "role must be ax or buff");
    const ttlDays = Number(body.ttlDays || 0);
    if (ttlDays && (ttlDays < 1 || ttlDays > 365)) return fail(400, "ttlDays must be between 1 and 365");
    if (!(await withinLimit(db, `c:${device.id}`, "keys", 10, 60000, now))) return fail(429, "rate limited");
    const plaintext = token(role);
    const hash = await sha256(plaintext);
    const keyId = newId();
    const expiresAt = ttlDays ? now + ttlDays * 86400000 : null;
    await db
      .prepare("INSERT INTO keys (id, bridge_id, role, label, hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(keyId, device.id, role, cleanStr(body.label, 60) || role, hash, plaintext.slice(0, 12), now, expiresAt)
      .run();
    return json({
      ok: true,
      id: keyId,
      role,
      label: cleanStr(body.label, 60) || role,
      token: plaintext,
      createdAt: now,
      expiresAt,
      note: "Store this token now. Only its hash is kept; it cannot be read again."
    });
  }

  if (method === "GET" && path === "/keys") {
    if (principal.role !== "owner") return forbidden(principal, "only the owner pairing code may list credentials");
    const rows = await db
      .prepare("SELECT id, role, label, prefix, created_at, expires_at, revoked_at, last_used FROM keys WHERE bridge_id = ? ORDER BY created_at DESC")
      .bind(device.id)
      .all();
    return json({
      ok: true,
      count: (rows.results || []).length,
      keys: (rows.results || []).map((row) => ({
        id: row.id,
        role: row.role,
        label: row.label,
        prefix: row.prefix,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        lastUsed: row.last_used,
        active: !row.revoked_at && (!row.expires_at || now <= row.expires_at)
      }))
    });
  }

  if (method === "POST" && path === "/keys/revoke") {
    if (principal.role !== "owner") return forbidden(principal, "only the owner pairing code may revoke credentials");
    const body = parsed.body;
    const keyId = cleanStr(body.id, 60);
    if (!keyId) return fail(400, "id required");
    const row = await db.prepare("SELECT id FROM keys WHERE id = ? AND bridge_id = ?").bind(keyId, device.id).first();
    if (!row) return fail(404, "no such credential");
    await db.prepare("UPDATE keys SET revoked_at = ? WHERE id = ?").bind(now, keyId).run();
    return json({ ok: true, id: keyId, revokedAt: now });
  }

  if (method === "POST" && path === "/note") {
    if (!allowed(principal, ["ax"])) return forbidden(principal, "only an ax credential may submit tasks");
    const body = parsed.body;
    const text = cleanStr(body.text, 4000);
    if (!text) return fail(400, "text required");
    if (!(await withinLimit(db, principal.rateKey, "note", 20, 60000, now))) return fail(429, "more than 20 tasks a minute");
    const taskId = newId();
    await db
      .prepare("INSERT INTO notes (id, bridge_id, source, text, ack, created_at, done, title) VALUES (?, ?, ?, ?, 0, ?, 0, ?)")
      .bind(taskId, device.id, cleanStr(body.source, 40) || "ax", text, now, cleanStr(body.title, 120) || null)
      .run();
    return json({ ok: true, taskId, createdAt: now, iso: iso(now) });
  }

  if (method === "GET" && path === "/notes") {
    if (!allowed(principal, ["buff"])) return forbidden(principal, "only a buff credential may read the task queue");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
    const rows = await db
      .prepare("SELECT id, source, text, title, ack, done, created_at FROM notes WHERE bridge_id = ? AND ack = 0 ORDER BY created_at LIMIT ?")
      .bind(device.id, limit)
      .all();
    const tasks = (rows.results || []).map((row) => ({
      id: row.id,
      text: row.text,
      title: row.title || undefined,
      source: row.source,
      status: noteStatus(row),
      createdAt: row.created_at,
      created_at: row.created_at,
      iso: iso(row.created_at)
    }));
    return json({ ok: true, count: tasks.length, tasks, notes: tasks });
  }

  if (method === "POST" && path === "/notes/ack") {
    if (!allowed(principal, ["buff"])) return forbidden(principal, "only a buff credential may claim tasks");
    const body = parsed.body;
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => cleanStr(id, 60)).filter(Boolean).slice(0, 50) : [];
    if (ids.length) {
      for (const id of ids) {
        await db.prepare("UPDATE notes SET ack = 1 WHERE bridge_id = ? AND id = ?").bind(device.id, id).run();
      }
      return json({ ok: true, acknowledged: ids.length });
    }
    await db.prepare("UPDATE notes SET ack = 1 WHERE bridge_id = ? AND ack = 0").bind(device.id).run();
    return json({ ok: true, acknowledged: "all" });
  }

  if (method === "GET" && path === "/tasks") {
    if (!allowed(principal, ["ax", "buff"])) return forbidden(principal, "this credential may not read task status");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
    const rows = await db
      .prepare(
        `SELECT n.id, n.text, n.title, n.source, n.ack, n.done, n.created_at,
                r.id AS reply_id, r.artifacts
           FROM notes n
           LEFT JOIN replies r ON r.task_id = n.id
          WHERE n.bridge_id = ?
          ORDER BY n.created_at DESC
          LIMIT ?`
      )
      .bind(device.id, limit)
      .all();
    const tasks = (rows.results || []).map((row) => ({
      id: row.id,
      text: row.text,
      title: row.title || undefined,
      source: row.source,
      status: noteStatus(row),
      createdAt: row.created_at,
      iso: iso(row.created_at),
      replyId: row.reply_id || undefined,
      artifacts: parseArtifacts(row.artifacts)
    }));
    return json({ ok: true, count: tasks.length, tasks });
  }

  if (method === "POST" && path === "/reply") {
    if (!allowed(principal, ["buff"])) return forbidden(principal, "only a buff credential may post replies");
    const body = parsed.body;
    const text = cleanStr(body.text, 4000);
    if (!text) return fail(400, "text required");
    const taskId = cleanStr(body.taskId, 60);
    if (taskId) {
      const task = await db
        .prepare("SELECT id FROM notes WHERE bridge_id = ? AND id = ?")
        .bind(device.id, taskId)
        .first();
      if (!task) return fail(400, "unknown taskId");
    }
    const artifacts = Array.isArray(body.artifacts) ? body.artifacts : [];
    if (artifacts.length > 10) return fail(400, "at most 10 artifacts");
    const cleanArtifacts = [];
    for (const item of artifacts) {
      const link = cleanStr(item, 300);
      if (!/^https?:\/\//i.test(link)) return fail(400, "artifacts must be http(s) links");
      cleanArtifacts.push(link);
    }
    if (!(await withinLimit(db, principal.rateKey, "reply", 60, 60000, now))) return fail(429, "rate limited");
    const replyId = newId();
    await db
      .prepare("INSERT INTO replies (id, bridge_id, source, text, created_at, task_id, artifacts) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(replyId, device.id, cleanStr(body.source, 40) || "buff", text, now, taskId || null, JSON.stringify(cleanArtifacts))
      .run();
    if (taskId) {
      await db.prepare("UPDATE notes SET ack = 1, done = 1 WHERE bridge_id = ? AND id = ?").bind(device.id, taskId).run();
    }
    return json({ ok: true, replyId, taskId: taskId || undefined, createdAt: now, iso: iso(now) });
  }

  if (method === "GET" && path === "/replies") {
    if (!allowed(principal, ["ax", "buff"])) return forbidden(principal, "this credential may not read replies");
    const since = Number(url.searchParams.get("since") || 0) || 0;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 50);
    const taskId = cleanStr(url.searchParams.get("taskId"), 60);
    const rows = taskId
      ? await db
          .prepare("SELECT id, task_id, source, text, artifacts, created_at FROM replies WHERE bridge_id = ? AND created_at > ? AND task_id = ? ORDER BY created_at LIMIT ?")
          .bind(device.id, since, taskId, limit)
          .all()
      : await db
          .prepare("SELECT id, task_id, source, text, artifacts, created_at FROM replies WHERE bridge_id = ? AND created_at > ? ORDER BY created_at LIMIT ?")
          .bind(device.id, since, limit)
          .all();
    const replies = (rows.results || []).map((row) => ({
      id: row.id,
      taskId: row.task_id || null,
      source: row.source,
      text: row.text,
      artifacts: parseArtifacts(row.artifacts),
      createdAt: row.created_at,
      created_at: row.created_at,
      iso: iso(row.created_at)
    }));
    return json({ ok: true, count: replies.length, serverTime: now, replies });
  }

  if (method === "POST" && path === "/files") {
    if (!allowed(principal, ["buff"])) return forbidden(principal, "only a buff credential may upload shared files");
    const body = parsed.body;
    const nameProblem = badFileName(body.name);
    if (nameProblem) return fail(400, nameProblem);
    const name = String(body.name).trim();
    if (typeof body.content !== "string") return fail(400, "content must be a string");
    const content = body.content;
    if (!content.length) return fail(400, "content required");
    if (content.length > MAX_FILE_CHARS) return fail(413, `file too large (${MAX_FILE_CHARS} characters)`);
    if (!(await withinLimit(db, principal.rateKey, "files", 60, 60000, now))) return fail(429, "rate limited");
    const encoding = body.encoding === "base64" ? "base64" : "text";
    const bytes = new TextEncoder().encode(content).length;
    const hash = await sha256(content);
    await db.prepare("DELETE FROM files WHERE bridge_id = ? AND name = ?").bind(device.id, name).run();
    await db
      .prepare("INSERT INTO files (id, bridge_id, name, mime, data, encoding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(newId(), device.id, name, cleanStr(body.mime, 60) || "text/plain", content, encoding, now)
      .run();
    return json({ ok: true, name, bytes, sha256: hash, updatedAt: now, iso: iso(now) });
  }

  if (method === "GET" && path === "/files") {
    if (!allowed(principal, ["ax", "buff"])) return forbidden(principal, "this credential may not read shared files");
    const rows = await db
      .prepare("SELECT name, mime, encoding, length(data) AS size, created_at FROM files WHERE bridge_id = ? ORDER BY created_at DESC")
      .bind(device.id)
      .all();
    const files = (rows.results || []).map((row) => ({
      name: row.name,
      mime: row.mime,
      encoding: row.encoding,
      size: row.size,
      bytes: row.size,
      updatedAt: row.created_at,
      iso: iso(row.created_at)
    }));
    return json({ ok: true, count: files.length, files });
  }

  if (method === "GET" && path === "/file") {
    if (!allowed(principal, ["ax", "buff"])) return forbidden(principal, "this credential may not read shared files");
    const rawName = url.searchParams.get("name");
    const nameProblem = badFileName(rawName);
    if (nameProblem) return fail(400, nameProblem);
    const row = await db
      .prepare("SELECT name, mime, data, encoding, created_at FROM files WHERE bridge_id = ? AND name = ?")
      .bind(device.id, String(rawName).trim())
      .first();
    if (!row) return fail(404, "no such file");
    return json({
      ok: true,
      name: row.name,
      mime: row.mime,
      encoding: row.encoding,
      size: row.data.length,
      updatedAt: row.created_at,
      iso: iso(row.created_at),
      data: row.data
    });
  }

  if (method === "POST" && path === "/send") {
    if (!allowed(principal, ["ax"])) return forbidden(principal, "only an ax credential may queue phone commands");
    const body = parsed.body;
    const action = cleanStr(body.action, 40);
    const spec = ACTIONS[action];
    if (!spec) return fail(400, `unknown action (allowed: ${Object.keys(ACTIONS).join(", ")})`);
    let arg = cleanStr(body.arg, spec.max || 60);
    if (spec.arg === "none") {
      arg = "";
    } else if (spec.arg === "one") {
      arg = arg.toLowerCase();
      if (!spec.values.includes(arg)) return fail(400, `arg must be one of ${spec.values.join(", ")}`);
    } else if (spec.arg === "text") {
      if (!arg) return fail(400, "arg required for this action");
      if (action === "url" && !/^https:\/\//i.test(arg)) return fail(400, "url must start with https://");
      if (action === "remote" && !arg.includes("|")) return fail(400, "remote arg must be 'key|device name'");
    }
    if (!(await withinLimit(db, principal.rateKey, "send", 30, 60000, now))) return fail(429, "more than 30 commands a minute");
    const id = newId();
    await db
      .prepare("INSERT INTO commands (id, bridge_id, action, arg, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .bind(id, device.id, action, arg, now)
      .run();
    return json({ ok: true, id, action, arg, queuedAt: now, iso: iso(now) });
  }

  if (method === "GET" && path === "/state") {
    if (!allowed(principal, ["ax"])) return forbidden(principal, "this credential may not read phone state");
    const rows = await db
      .prepare(
        `SELECT c.id, c.action, c.arg, c.status, c.created_at, r.output
           FROM commands c LEFT JOIN results r ON r.command_id = c.id
          WHERE c.bridge_id = ? ORDER BY c.created_at DESC LIMIT 10`
      )
      .bind(device.id)
      .all();
    return json({
      ok: true,
      name: device.name,
      lastSeen: device.last_seen,
      online: !!(device.last_seen && now - device.last_seen < 45000),
      serverTime: now,
      commands: (rows.results || []).map((row) => ({
        id: row.id,
        action: row.action,
        arg: row.arg,
        status: row.status,
        output: row.output || null,
        createdAt: row.created_at,
        iso: iso(row.created_at)
      }))
    });
  }

  return fail(404, `no route for ${method} ${path}`);
}
