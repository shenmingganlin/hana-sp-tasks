import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BRIDGE_PORT, BRIDGE_PROTOCOL, BRIDGE_READY, BRIDGE_AUTH_FILE, HttpError, bad, keys, text, validateCommand, validateResult } from "../lib/bridge-protocol.js";
const METHODS = new Map([
  ["/internal/status", ["GET"]],
  ["/internal/execute", ["POST"]],
  ["/internal/disable", ["POST"]],
  ["/plugin/poll", ["GET", "POST"]],
  ["/plugin/result", ["POST"]],
]);
const writing = (op) => !op.endsWith(".list");
const failure = (code, message, outcomeUnknown = false) => ({ ok: false, error: { code, message }, ...(outcomeUnknown ? { outcomeUnknown: true } : {}) });
const success = (data) => ({ ok: true, data });

function authorized(header, token) {
  if (typeof header !== "string") return false;
  const actual = Buffer.from(header), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function jsonResponse(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(value));
}
async function readJson(req, maxBytes) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw new HttpError(415, "SP_BRIDGE_CONTENT_TYPE", "Use application/json.");
  const length = req.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new HttpError(413, "SP_BRIDGE_TOO_LARGE", "Request body exceeds the bridge limit.");
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "SP_BRIDGE_TOO_LARGE", "Request body exceeds the bridge limit.");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { bad("Malformed JSON."); }
}

/** A private, bounded transport; it never imports SP or executes commands itself. */
export async function createBridgeServer({
  controlToken, pluginToken, port = BRIDGE_PORT, executeTimeoutMs = 12000, leaseMs = 30000, holdMs = Math.floor(leaseMs * 2 / 3),
  requestMaxBytes = 64 * 1024, responseMaxBytes = 1024 * 1024, maxPending = 32, receiptLimit = 256,
} = {}) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(controlToken || "") || !/^[A-Za-z0-9_-]{32,128}$/.test(pluginToken || "") || controlToken === pluginToken) throw new Error("Independent bridge credentials are required.");
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(executeTimeoutMs) || executeTimeoutMs < 1 || executeTimeoutMs > 12000 || leaseMs < executeTimeoutMs || !Number.isInteger(holdMs) || holdMs < 0 || holdMs >= leaseMs) throw new Error("Invalid bridge limits.");
  const commands = new Map();
  // Held long polls: each waits for a new or settled command, or its hold to end.
  const waiters = new Set();
  let lease = null, closing = false;
  const status = () => ({ connected: !!lease && lease.expiresAt > Date.now(), accepting: !closing, pluginVersion: lease?.version ?? null, lastSeen: lease?.lastSeen ?? null, protocol: BRIDGE_PROTOCOL });
  function prune() {
    let completed = [...commands.values()].filter((command) => command.settled);
    while (completed.length > receiptLimit) commands.delete(completed.shift().id);
  }
  function settle(command, result) {
    if (command.settled) return;
    command.settled = true; clearTimeout(command.timer);
    jsonResponse(command.res, 200, result); command.res = null; command.args = null; prune();
    wake();
  }
  /** Answers held polls that can now make progress; the rest keep waiting. */
  function wake() {
    for (const waiter of [...waiters]) {
      if (waiter.res.destroyed) { waiters.delete(waiter); clearTimeout(waiter.timer); continue; }
      let reply;
      try { reply = poll(waiter.input, false); } catch (error) { release(waiter, error); continue; }
      if (reply.data.command) release(waiter, reply);
    }
  }
  function release(waiter, reply) {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (reply instanceof HttpError) jsonResponse(waiter.res, reply.status, failure(reply.code, reply.message));
    else jsonResponse(waiter.res, 200, reply);
  }
  function hold(res, input) {
    const waiter = { res, input };
    waiter.timer = setTimeout(() => {
      let reply;
      try { reply = poll(input, false); } catch (error) { reply = error; }
      release(waiter, reply);
    }, holdMs);
    waiters.add(waiter);
    res.on("close", () => { waiters.delete(waiter); clearTimeout(waiter.timer); });
  }
  function timeout(command) {
    settle(command, failure(command.delivered ? "SP_BRIDGE_RESULT_TIMEOUT" : "SP_BRIDGE_NOT_CONNECTED", command.delivered ? "The plugin did not confirm the result; query SP before retrying." : "No paired SP plugin collected the command before its deadline.", command.delivered && writing(command.op)));
  }
  function expireCommands() {
    const now = Date.now();
    for (const command of commands.values()) if (!command.settled && command.expiresAt <= now) timeout(command);
  }
  function client(input) {
    if (!text(input.clientId, 128) || !/^[A-Za-z0-9_-]+$/.test(input.clientId)) bad("Invalid SP client ID.");
    return input.clientId;
  }
  // `longPoll` tells a newer plugin it may send `wait: true`; older plugins ignore it.
  function poll(input, validate = true) {
    if (validate) {
      keys(input, ["clientId", "version", "protocol", "wait"]);
      client(input);
      if (input.protocol !== BRIDGE_PROTOCOL || !text(input.version, 80)) bad("Unsupported plugin protocol or version.");
      if (Object.hasOwn(input, "wait") && typeof input.wait !== "boolean") bad("wait must be a boolean.");
    }
    const clientId = input.clientId;
    expireCommands();
    const now = Date.now();
    if (lease && lease.clientId !== clientId && lease.expiresAt > now) throw new HttpError(409, "SP_BRIDGE_CLIENT_BUSY", "Another SP instance holds this bridge connection.");
    // A held poll counts as presence for its whole hold; holdMs < leaseMs keeps it connected.
    lease = { clientId, version: input.version, lastSeen: now, expiresAt: now + leaseMs };
    // Each client executes serially. Delivered commands are never reissued.
    if ([...commands.values()].some((command) => !command.settled && command.delivered)) return success({ command: null, longPoll: true });
    const command = [...commands.values()].find((entry) => !entry.settled && !entry.delivered && entry.expiresAt > now);
    if (!command) return success({ command: null, longPoll: true });
    command.delivered = true; command.clientId = clientId;
    return success({ command: { id: command.id, op: command.op, args: command.args, expiresAt: command.expiresAt }, longPoll: true });
  }
  function report(input) {
    keys(input, ["clientId", "id", "result"]);
    const clientId = client(input);
    if (!text(input.id, 128)) bad("Invalid command ID.");
    const command = commands.get(input.id);
    if (!command || !command.delivered || command.clientId !== clientId) throw new HttpError(409, "SP_BRIDGE_RESULT_MISMATCH", "The result does not belong to this client and command.");
    const result = validateResult(input.result), serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > responseMaxBytes) throw new HttpError(413, "SP_BRIDGE_TOO_LARGE", "Result exceeds the bridge limit.");
    const fingerprint = createHash("sha256").update(serialized).digest("hex");
    if (command.pluginResult !== undefined) {
      if (command.pluginResult !== fingerprint) throw new HttpError(409, "SP_BRIDGE_RESULT_CONFLICT", "A different result was already accepted.");
      return success({ accepted: true, id: command.id, duplicate: true, ...(command.late ? { late: true } : {}) });
    }
    expireCommands();
    command.pluginResult = fingerprint; command.late = command.settled;
    if (!command.settled) settle(command, result);
    if (lease?.clientId === clientId) { lease.lastSeen = Date.now(); lease.expiresAt = lease.lastSeen + leaseMs; }
    return success({ accepted: true, id: command.id, ...(command.late ? { late: true } : {}) });
  }
  async function handle(req, res) {
    const boundPort = server.address()?.port;
    if (![ `127.0.0.1:${boundPort}`, `localhost:${boundPort}` ].includes(req.headers.host)) throw new HttpError(403, "SP_BRIDGE_HOST_REJECTED", "Invalid loopback Host header.");
    let url;
    try { url = new URL(req.url, "http://127.0.0.1"); } catch { bad("Invalid route."); }
    const methods = METHODS.get(url.pathname);
    if (!methods) throw new HttpError(404, "SP_BRIDGE_NOT_FOUND", "Unknown bridge route.");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": methods.join(", "), "Access-Control-Allow-Headers": "Authorization, Content-Type", "Cache-Control": "no-store" }); res.end(); return;
    }
    if (!methods.includes(req.method)) throw new HttpError(405, "SP_BRIDGE_METHOD", "Unsupported HTTP method.");
    const token = url.pathname.startsWith("/internal/") ? controlToken : pluginToken;
    if (!authorized(req.headers.authorization, token)) throw new HttpError(401, "SP_BRIDGE_UNAUTHORIZED", "Bridge credential rejected.");
    if (closing && !["/internal/status", "/internal/disable"].includes(url.pathname)) throw new HttpError(503, "SP_BRIDGE_STOPPING", "Bridge is stopping.");
    if (url.pathname !== "/plugin/poll" && url.search) bad("This route does not accept query parameters.");
    if (url.pathname === "/internal/status") { jsonResponse(res, 200, success(status())); return; }
    let input;
    if (req.method === "GET") {
      if ([...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) bad("Duplicate query parameters.");
      input = Object.fromEntries(url.searchParams);
      if (input.protocol === "1") input.protocol = 1;
      if (input.wait === "1") input.wait = true;
    } else {
      if (url.search) bad("POST requests do not accept query parameters.");
      input = await readJson(req, url.pathname === "/plugin/result" ? responseMaxBytes + 2048 : requestMaxBytes);
    }
    if (url.pathname === "/internal/disable") {
      keys(input, []); quiesce(); jsonResponse(res, 200, success({ disabled: true })); return;
    }
    if (url.pathname === "/plugin/poll") {
      const reply = poll(input);
      if (input.wait === true && holdMs > 0 && !reply.data.command) hold(res, input);
      else jsonResponse(res, 200, reply);
      return;
    }
    if (url.pathname === "/plugin/result") { jsonResponse(res, 200, report(input)); return; }
    keys(input, ["op", "args"]);
    validateCommand(input.op, input.args); expireCommands();
    if ([...commands.values()].filter((command) => !command.settled).length >= maxPending) throw new HttpError(429, "SP_BRIDGE_BUSY", "Bridge command queue is full.");
    const command = { id: randomUUID(), op: input.op, args: input.args, expiresAt: Date.now() + executeTimeoutMs, delivered: false, settled: false, res };
    commands.set(command.id, command); command.timer = setTimeout(() => timeout(command), executeTimeoutMs);
    res.on("close", () => { if (!command.settled) settle(command, failure("SP_BRIDGE_CALLER_GONE", "The caller disconnected.", command.delivered && writing(command.op))); });
    wake();
  }
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => jsonResponse(res, error instanceof HttpError ? error.status : 500, failure(error instanceof HttpError ? error.code : "SP_BRIDGE_INTERNAL", error instanceof HttpError ? error.message : "Bridge request failed.")));
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  server.on("clientError", (_error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  server.on("error", () => {});
  let closePromise;
  function quiesce() {
    closing = true; lease = null;
    for (const waiter of [...waiters]) release(waiter, new HttpError(503, "SP_BRIDGE_STOPPING", "Bridge is stopping."));
    for (const command of commands.values()) settle(command, failure("SP_BRIDGE_STOPPED", "Bridge stopped before the result was confirmed.", command.delivered && writing(command.op)));
  }
  return {
    server, port: server.address().port, status,
    close() {
      if (closePromise) return closePromise;
      quiesce();
      closePromise = new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
      return closePromise;
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length && !/^\d+$/.test(args[0])) throw new Error("Invalid bridge port argument.");
  const port = args.length ? Number(args[0]) : BRIDGE_PORT;
  if (port < 1024 || port > 65535) throw new Error("Invalid bridge port.");
  const file = await readFile(path.resolve(process.cwd(), BRIDGE_AUTH_FILE), "utf8");
  if (Buffer.byteLength(file) > 2048) throw new Error("Invalid bridge credential file.");
  const auth = JSON.parse(file);
  if (auth.protocol !== BRIDGE_PROTOCOL) throw new Error("Unsupported bridge credentials.");
  const service = await createBridgeServer({ controlToken: auth.controlToken, pluginToken: auth.pluginToken, port });
  const stop = () => { void service.close().then(() => process.exit(0)); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop); process.once("disconnect", stop);
  process.stdout.write(`${BRIDGE_READY}\n`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => {
    process.stderr.write(error?.code === "EADDRINUSE" ? "SP_BRIDGE_PORT_IN_USE: port 3877 or the configured port is already occupied.\n" : "SP_BRIDGE_START_FAILED: check runtime permissions and bridge configuration.\n");
    process.exitCode = 1;
  });
}
