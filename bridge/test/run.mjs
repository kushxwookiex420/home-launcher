// Relay tests. They import the real worker module and drive it through its fetch handler with a
// D1 stand-in backed by node:sqlite, so requests, validation, SQL and auth are all exercised.
//
//   node bridge/test/run.mjs

import assert from "node:assert/strict";
import worker from "../index.js";
import { makeD1 } from "./d1.mjs";

const BASE = "https://bridge.test";
const env = { DB: makeD1() };

let passed = 0;
const failures = [];

async function call(method, path, body, headers = {}) {
  const init = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await worker.fetch(new Request(BASE + path, init), env);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

const post = (path, body, headers) => call("POST", path, body, headers);
const get = (path, headers) => call("GET", path, undefined, headers);

// ---------------------------------------------------------------------------

console.log("relay tests");

const registered = await post("/bridge", { name: "test phone" });
const code = registered.data.code;
const deviceId = registered.data.id;

await test("health reports the database", async () => {
  const { status, data } = await get("/health");
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.db, true);
});

await test("pairing returns a six character code", async () => {
  assert.equal(registered.status, 200);
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.ok(deviceId);
});

await test("no code is rejected with 401", async () => {
  const { status, data } = await post("/note", { text: "hello" });
  assert.equal(status, 401);
  assert.equal(data.ok, false);
});

await test("malformed and unknown codes are rejected with 401", async () => {
  assert.equal((await post("/note", { code: "abc", text: "x" })).status, 401);
  assert.equal((await post("/note", { code: "ZZZZZZ", text: "x" })).status, 401);
  assert.equal((await get("/replies?code=ZZZZZZ")).status, 401);
});

await test("the pairing code is accepted as a bearer token", async () => {
  const { status } = await get("/files", { authorization: `Bearer ${code}` });
  assert.equal(status, 200);
});

let firstTaskId;
await test("a task can be submitted with source chatgpt", async () => {
  const { status, data } = await post("/note", { code, text: "add a stopwatch to CONTROL", source: "chatgpt", title: "stopwatch" });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.taskId);
  assert.ok(data.createdAt > 0);
  firstTaskId = data.taskId;
});

await test("an empty task is rejected", async () => {
  const { status, data } = await post("/note", { code, text: "   " });
  assert.equal(status, 400);
  assert.equal(data.code, "bad_request");
});

await test("invalid json is a 400, not a crash", async () => {
  const { status, data } = await post("/note", "{not json", {});
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test("queued tasks are listed with ids and timestamps", async () => {
  const { status, data } = await get(`/notes?code=${code}`);
  assert.equal(status, 200);
  assert.equal(data.count, 1);
  assert.equal(data.tasks[0].id, firstTaskId);
  assert.equal(data.tasks[0].status, "queued");
  assert.equal(data.tasks[0].source, "chatgpt");
  assert.ok(data.tasks[0].iso);
});

await test("task status shows queued then working", async () => {
  assert.equal((await get(`/tasks?code=${code}`)).data.tasks[0].status, "queued");
  const ack = await post("/notes/ack", { code, ids: [firstTaskId] });
  assert.equal(ack.status, 200);
  assert.equal((await get(`/notes?code=${code}`)).data.count, 0);
  assert.equal((await get(`/tasks?code=${code}`)).data.tasks[0].status, "working");
});

await test("a reply can be linked to the task with artifacts", async () => {
  const { status, data } = await post("/reply", {
    code,
    taskId: firstTaskId,
    text: "0.58 built, stopwatch added",
    artifacts: ["https://files.catbox.moe/example.apk"]
  });
  assert.equal(status, 200);
  assert.equal(data.taskId, firstTaskId);
  const tasks = (await get(`/tasks?code=${code}`)).data.tasks;
  assert.equal(tasks[0].status, "done");
  assert.equal(tasks[0].replyId, data.replyId);
  assert.deepEqual(tasks[0].artifacts, ["https://files.catbox.moe/example.apk"]);
});

await test("reply validation rejects a bad task, a bad link and empty text", async () => {
  assert.equal((await post("/reply", { code, taskId: "nope", text: "x" })).status, 400);
  assert.equal((await post("/reply", { code, text: "x", artifacts: ["javascript:alert(1)"] })).status, 400);
  assert.equal((await post("/reply", { code, text: "" })).status, 400);
  assert.equal((await post("/reply", { code, text: "x", artifacts: new Array(11).fill("https://a.test/x") })).status, 400);
});

await test("replies come back with taskId, timestamps and artifacts", async () => {
  const { status, data } = await get(`/replies?code=${code}`);
  assert.equal(status, 200);
  assert.equal(data.count, 1);
  assert.equal(data.replies[0].taskId, firstTaskId);
  assert.ok(data.replies[0].createdAt > 0);
  assert.ok(data.replies[0].iso);
  assert.equal(data.replies[0].artifacts.length, 1);
  assert.ok(data.serverTime > 0);
});

await test("replies can be filtered by since and by taskId", async () => {
  const future = Date.now() + 60000;
  assert.equal((await get(`/replies?code=${code}&since=${future}`)).data.count, 0);
  assert.equal((await get(`/replies?code=${code}&taskId=${firstTaskId}`)).data.count, 1);
  assert.equal((await get(`/replies?code=${code}&taskId=other`)).data.count, 0);
  assert.equal((await get(`/replies?code=${code}&limit=1`)).data.count, 1);
});

await test("a shared file can be uploaded, listed and read", async () => {
  const up = await post("/files", { code, name: "docs/report.md", content: "# report\nall good\n" });
  assert.equal(up.status, 200);
  assert.equal(up.data.bytes, 18);
  assert.match(up.data.sha256, /^[0-9a-f]{64}$/);
  const list = await get(`/files?code=${code}`);
  assert.equal(list.data.count, 1);
  assert.equal(list.data.files[0].name, "docs/report.md");
  const read = await get(`/file?code=${code}&name=docs/report.md`);
  assert.equal(read.status, 200);
  assert.equal(read.data.data, "# report\nall good\n");
  assert.equal(read.data.encoding, "text");
});

await test("files can be base64 binary", async () => {
  const up = await post("/files", { code, name: "artifacts/icon.png", content: "iVBORw0KGgo=", encoding: "base64", mime: "image/png" });
  assert.equal(up.status, 200);
  assert.equal((await get(`/file?code=${code}&name=artifacts/icon.png`)).data.encoding, "base64");
});

await test("path traversal, absolute paths, hidden files and key files are refused", async () => {
  for (const name of ["../etc/passwd", "/etc/passwd", "a/../../b", "docs/./x", "..", ".env", "config/.env.local", "keys/id_rsa", "app/release.keystore", "a b.txt", "a\\b.txt"]) {
    const { status } = await post("/files", { code, name, content: "x" });
    assert.equal(status, 400, `expected 400 for ${name}`);
  }
});

await test("oversized files are refused with 413", async () => {
  const { status, data } = await post("/files", { code, name: "big.txt", content: "x".repeat(200001) });
  assert.equal(status, 413);
  assert.equal(data.code, "too_large");
});

await test("reading a missing file is a 404", async () => {
  const { status, data } = await get(`/file?code=${code}&name=docs/absent.md`);
  assert.equal(status, 404);
  assert.equal(data.ok, false);
});

await test("whitelisted phone actions are queued with an id", async () => {
  const { status, data } = await post("/send", { code, action: "page", arg: "control" });
  assert.equal(status, 200);
  assert.ok(data.id);
  assert.equal(data.action, "page");
});

await test("unknown actions and bad arguments are refused", async () => {
  assert.equal((await post("/send", { code, action: "shell", arg: "ls" })).status, 400);
  assert.equal((await post("/send", { code, action: "page", arg: "root" })).status, 400);
  assert.equal((await post("/send", { code, action: "url", arg: "http://insecure.test" })).status, 400);
  assert.equal((await post("/send", { code, action: "remote", arg: "home" })).status, 400);
});

await test("the phone can poll the queue and report a result", async () => {
  const poll = await post("/poll", { id: deviceId, code });
  assert.equal(poll.status, 200);
  assert.equal(poll.data.command.action, "page");
  assert.equal(poll.data.command.arg, "control");
  const result = await post("/result", { id: deviceId, code, commandId: poll.data.command.id, output: "switched to CONTROL" });
  assert.equal(result.status, 200);
  const state = await get(`/state?code=${code}`);
  assert.equal(state.status, 200);
  assert.equal(state.data.online, true);
  assert.equal(state.data.commands[0].status, "done");
  assert.equal(state.data.commands[0].output, "switched to CONTROL");
});

await test("polling with the wrong device id is refused", async () => {
  assert.equal((await post("/poll", { id: "nope", code })).status, 404);
});

await test("a second device cannot read the first device's data", async () => {
  const other = (await post("/bridge", { name: "other" })).data;
  assert.equal((await get(`/replies?code=${other.code}`)).data.count, 0);
  assert.equal((await get(`/files?code=${other.code}`)).data.count, 0);
  assert.equal((await get(`/file?code=${other.code}&name=docs/report.md`)).status, 404);
});

await test("sending more than 30 actions a minute is rate limited", async () => {
  let limited = null;
  for (let i = 0; i < 40 && !limited; i++) {
    const { status } = await post("/send", { code, action: "status" });
    if (status === 429) limited = status;
  }
  assert.equal(limited, 429);
});

await test("unknown routes are 404", async () => {
  const { status, data } = await get(`/nope?code=${code}`);
  assert.equal(status, 404);
  assert.equal(data.ok, false);
});

await test("the OpenAPI document describes every operation", async () => {
  const { status, data } = await get("/openapi.json");
  assert.equal(status, 200);
  assert.equal(data.info.version, "1.3.0");
  const ops = Object.values(data.paths).flatMap((path) => Object.values(path).map((op) => op.operationId));
  for (const id of ["handTaskToAgent", "readAgentReplies", "taskStatus", "pendingTasks", "uploadSharedFile", "listSharedFiles", "readSharedFile", "sendToPhone", "phoneState", "mintCredential", "listCredentials", "revokeCredential"]) {
    assert.ok(ops.includes(id), `missing ${id}`);
  }
  assert.ok(data.components.securitySchemes.pairingCode);
  assert.ok(!JSON.stringify(data.paths).includes("$ref"), "served schema must be inlined for ChatGPT");
  assert.ok(data.paths["/note"].post.responses["401"]);
});


// ---- credential roles -------------------------------------------------------

let axToken = null;
let buffToken = null;
let buffKeyId = null;

await test("owner can mint separate ax and buff credentials", async () => {
  const ax = await post("/keys", { code, role: "ax", label: "chatgpt", ttlDays: 30 });
  assert.equal(ax.status, 200);
  assert.match(ax.data.token, /^hb_ax_[0-9a-f]{48}$/);
  assert.ok(ax.data.expiresAt > Date.now());
  const buff = await post("/keys", { code, role: "buff", label: "agent" });
  assert.equal(buff.status, 200);
  assert.match(buff.data.token, /^hb_buff_[0-9a-f]{48}$/);
  assert.equal(buff.data.expiresAt, null);
  axToken = ax.data.token;
  buffToken = buff.data.token;
  buffKeyId = buff.data.id;
});

await test("the credential list hides the tokens", async () => {
  const { status, data } = await get(`/keys?code=${code}`);
  assert.equal(status, 200);
  assert.equal(data.count, 2);
  assert.equal(JSON.stringify(data).includes(axToken), false);
  assert.ok(data.keys.every((k) => k.id && k.role && k.prefix && k.active === true));
});

await test("a role credential cannot mint or list credentials", async () => {
  const mint = await post("/keys", { role: "ax" }, { authorization: `Bearer ${axToken}` });
  assert.equal(mint.status, 403);
  const list = await get("/keys", { authorization: `Bearer ${axToken}` });
  assert.equal(list.status, 403);
  const revoke = await post("/keys/revoke", { id: buffKeyId }, { authorization: `Bearer ${buffToken}` });
  assert.equal(revoke.status, 403);
});

await test("ax can submit a task and read its status", async () => {
  const note = await post("/note", { text: "ax role: add a timer", title: "timer", source: "chatgpt" }, { authorization: `Bearer ${axToken}` });
  assert.equal(note.status, 200);
  assert.ok(note.data.taskId);
  const tasks = await get("/tasks", { authorization: `Bearer ${axToken}` });
  assert.equal(tasks.status, 200);
  assert.ok(tasks.data.tasks.some((t) => t.id === note.data.taskId));
});

await test("ax cannot reply, upload, claim tasks or read the queue", async () => {
  const auth = { authorization: `Bearer ${axToken}` };
  assert.equal((await post("/reply", { text: "nope" }, auth)).status, 403);
  assert.equal((await post("/files", { name: "x/y.md", content: "x" }, auth)).status, 403);
  assert.equal((await post("/notes/ack", { ids: ["x"] }, auth)).status, 403);
  assert.equal((await get("/notes", auth)).status, 403);
});

await test("ax can queue an approved phone action and read phone state", async () => {
  const send = await post("/send", { action: "torch", arg: "on" }, { authorization: `Bearer ${axToken}` });
  assert.equal(send.status, 200);
  assert.ok(send.data.id);
  const state = await get("/state", { authorization: `Bearer ${axToken}` });
  assert.equal(state.status, 200);
  assert.equal(state.data.commands[0].action, "torch");
  assert.equal((await post("/send", { action: "shell", arg: "id" }, { authorization: `Bearer ${axToken}` })).status, 400);
});

await test("buff can claim tasks, reply and upload artifacts", async () => {
  const auth = { authorization: `Bearer ${buffToken}` };
  const queue = await get("/notes", auth);
  assert.equal(queue.status, 200);
  const taskId = queue.data.tasks[0].id;
  const ack = await post("/notes/ack", { ids: [taskId] }, auth);
  assert.equal(ack.status, 200);
  const reply = await post("/reply", { taskId, text: "timer built", artifacts: ["https://files.catbox.moe/x.apk"] }, auth);
  assert.equal(reply.status, 200);
  const files = await post("/files", { name: "reports/timer.md", content: "# timer" }, auth);
  assert.equal(files.status, 200);
  const read = await get("/file?name=reports/timer.md", auth);
  assert.equal(read.status, 200);
  assert.equal(read.data.data, "# timer");
  const done = await get(`/tasks?limit=5`, auth);
  assert.equal(done.data.tasks.find((t) => t.id === taskId).status, "done");
});

await test("buff cannot submit tasks, queue phone commands or read phone state", async () => {
  const auth = { authorization: `Bearer ${buffToken}` };
  assert.equal((await post("/note", { text: "impersonation" }, auth)).status, 403);
  assert.equal((await post("/send", { action: "torch", arg: "on" }, auth)).status, 403);
  assert.equal((await get("/state", auth)).status, 403);
});

await test("a revoked credential stops working immediately", async () => {
  const fresh = (await post("/keys", { code, role: "buff", label: "rotate-me" })).data;
  const before = await get("/notes", { authorization: `Bearer ${fresh.token}` });
  assert.equal(before.status, 200);
  assert.equal((await post("/keys/revoke", { code, id: fresh.id })).status, 200);
  const after = await get("/notes", { authorization: `Bearer ${fresh.token}` });
  assert.equal(after.status, 401);
  assert.equal(after.data.code, "unauthorized");
});

await test("an expired credential is refused", async () => {
  const expired = "hb_ax_" + "a".repeat(48);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expired));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare(
    "INSERT INTO keys (id, bridge_id, role, label, hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind("expired-key", deviceId, "ax", "expired", hash, expired.slice(0, 12), Date.now() - 10000, Date.now() - 1000).run();
  const res = await get("/tasks", { authorization: `Bearer ${expired}` });
  assert.equal(res.status, 401);
  assert.match(res.data.error, /expired/);
});

await test("a credential is bound to its own phone", async () => {
  const other = (await post("/bridge", { name: "second phone" })).data;
  const otherKey = (await post("/keys", { code: other.code, role: "ax", label: "other" })).data;
  const files = await get("/files", { authorization: `Bearer ${otherKey.token}` });
  assert.equal(files.status, 200);
  assert.equal(files.data.count, 0);
  const thisFiles = await get(`/files?code=${code}`);
  assert.ok(thisFiles.data.count > 0);
});

await test("unknown and malformed tokens are refused", async () => {
  assert.equal((await get("/tasks", { authorization: "Bearer hb_ax_" + "f".repeat(48) })).status, 401);
  assert.equal((await get("/tasks", { authorization: "Bearer not-a-token" })).status, 401);
  assert.equal((await get("/tasks")).status, 401);
});

// ---------------------------------------------------------------------------

console.log("");
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const { name, error } of failures) console.log(`\n${name}\n${error.stack}`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
