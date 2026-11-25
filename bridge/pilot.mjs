#!/usr/bin/env node
/**
 * AI pilot bridge: a local relay between a Foundry tab and Claude Code.
 * ---------------------------------------------------------------------
 * The Foundry tab (ptr-ai-pilot's scripts/ai-pilot.js, with "Connect AI pilot bridge" on) long-polls this
 * server for commands and posts results and turn events back. Claude drives it with the CLI:
 *
 *   node bridge/pilot.mjs serve              start the bridge (leave it running)
 *   node bridge/pilot.mjs status             is a Foundry tab connected?
 *   node bridge/pilot.mjs wait [--timeout S] block until the next event (a pilot turn, ...)
 *   node bridge/pilot.mjs call <cmd> [json]  run a command in the Foundry tab, print the result
 *   node bridge/pilot.mjs token              print the token to paste into Foundry
 *
 * Listens on 127.0.0.1 only (port 47321, or PILOT_PORT). Every request needs the shared token
 * in the `x-pilot-token` header: a random value kept in bridge/.token (git-ignored), so other
 * web pages in the browser can't drive it. No dependencies beyond Node 18+.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(HERE, ".token");
const PORT = Number(process.env.PILOT_PORT) || 47321;
const HOST = "127.0.0.1";
const POLL_HOLD_MS = 25_000;      // Foundry long-poll hold
const WAIT_HOLD_MS = 50_000;      // Claude long-poll hold (the CLI loops)
const FOUNDRY_STALE_MS = 40_000;  // no poll for this long = disconnected
const MAX_EVENTS = 200;

function readToken({ create = false } = {}) {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {}
  if (!create) return null;
  const t = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(TOKEN_FILE, t + "\n");
  return t;
}

/* ------------------------------------------------------------------ *
 *  Server
 * ------------------------------------------------------------------ */

function serve() {
  const token = readToken({ create: true });
  const pending = [];              // commands waiting for the Foundry tab
  const results = new Map();       // command id -> resolve
  let pollWaiter = null;           // { res, timer } a held Foundry poll
  const events = [];               // undelivered events for Claude
  let eventSeq = 0;
  const eventWaiters = new Set();  // held Claude waits
  let foundry = { lastSeen: 0, user: null, world: null };

  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const connected = () => Date.now() - foundry.lastSeen < FOUNDRY_STALE_MS;

  function send(res, status, body, origin) {
    const headers = { "content-type": "application/json", "cache-control": "no-store" };
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["vary"] = "origin";
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  function flushPoll() {
    if (!pollWaiter || !pending.length) return;
    const { res, timer, origin } = pollWaiter;
    pollWaiter = null;
    clearTimeout(timer);
    send(res, 200, pending.splice(0), origin);
  }

  function flushEvents() {
    if (!events.length) return;
    for (const w of eventWaiters) {
      clearTimeout(w.timer);
      send(w.res, 200, { events: events.splice(0) });
      eventWaiters.delete(w);
      return; // one waiter gets them; the rest keep waiting
    }
  }

  async function body(req) {
    let data = "";
    for await (const chunk of req) {
      data += chunk;
      if (data.length > 5_000_000) throw new Error("body too large");
    }
    return data ? JSON.parse(data) : {};
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const origin = req.headers.origin;
    const isFoundry = url.pathname.startsWith("/foundry/");

    // CORS preflight — only the Foundry endpoints are reachable from a page.
    if (req.method === "OPTIONS") {
      if (!isFoundry) return send(res, 403, { error: "forbidden" });
      res.writeHead(204, {
        "access-control-allow-origin": origin ?? "*",
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type, x-pilot-token",
        "access-control-allow-private-network": "true",
        "access-control-max-age": "600",
        vary: "origin",
      });
      return res.end();
    }
    const corsOrigin = isFoundry ? origin : undefined;
    if (req.headers["x-pilot-token"] !== token) return send(res, 401, { error: "bad token" }, corsOrigin);

    try {
      switch (`${req.method} ${url.pathname}`) {
        case "GET /foundry/poll": {
          const wasConnected = connected();
          foundry.lastSeen = Date.now();
          foundry.user = url.searchParams.get("user") ?? foundry.user;
          foundry.world = url.searchParams.get("world") ?? foundry.world;
          if (!wasConnected) log(`Foundry connected: user "${foundry.user}", world "${foundry.world}"`);
          if (pollWaiter) send(pollWaiter.res, 200, [], pollWaiter.origin); // a newer poll replaces it
          pollWaiter = {
            res, origin,
            timer: setTimeout(() => {
              if (pollWaiter?.res !== res) return;
              pollWaiter = null;
              send(res, 200, [], origin);
            }, POLL_HOLD_MS),
          };
          req.on("close", () => { if (pollWaiter?.res === res && !res.writableEnded) { clearTimeout(pollWaiter.timer); pollWaiter = null; } });
          return flushPoll();
        }
        case "POST /foundry/result": {
          const { id, ...result } = await body(req);
          results.get(id)?.(result);
          results.delete(id);
          return send(res, 200, { ok: true }, corsOrigin);
        }
        case "POST /foundry/event": {
          const event = await body(req);
          event.seq = ++eventSeq;
          event.at ??= new Date().toISOString();
          events.push(event);
          if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
          log(`event ${event.type}${event.actor ? ` (${event.actor})` : ""}`);
          flushEvents();
          return send(res, 200, { ok: true }, corsOrigin);
        }
        case "GET /claude/wait": {
          if (events.length) return send(res, 200, { events: events.splice(0) });
          const w = { res, timer: setTimeout(() => { eventWaiters.delete(w); send(res, 200, { events: [] }); }, WAIT_HOLD_MS) };
          eventWaiters.add(w);
          req.on("close", () => { if (!res.writableEnded) { clearTimeout(w.timer); eventWaiters.delete(w); } });
          return;
        }
        case "POST /claude/call": {
          const { cmd, args = {}, timeout = 120 } = await body(req);
          if (!connected()) return send(res, 503, { ok: false, error: "No Foundry tab is connected to the bridge." });
          const id = crypto.randomUUID();
          const result = await new Promise((resolve) => {
            const timer = setTimeout(() => { results.delete(id); resolve({ ok: false, error: `Timed out after ${timeout}s` }); }, timeout * 1000);
            results.set(id, (r) => { clearTimeout(timer); resolve(r); });
            pending.push({ id, cmd, args });
            flushPoll();
          });
          log(`call ${cmd} -> ${result.ok ? "ok" : `error: ${result.error}`}`);
          return send(res, 200, result);
        }
        case "GET /status":
          return send(res, 200, {
            connected: connected(),
            user: foundry.user,
            world: foundry.world,
            lastSeenSecondsAgo: foundry.lastSeen ? Math.round((Date.now() - foundry.lastSeen) / 1000) : null,
            queuedEvents: events.length,
          });
        default:
          return send(res, 404, { error: "not found" }, corsOrigin);
      }
    } catch (err) {
      return send(res, 500, { ok: false, error: String(err?.message ?? err) }, corsOrigin);
    }
  });

  server.listen(PORT, HOST, () => {
    log(`AI pilot bridge on http://${HOST}:${PORT}`);
    log(`Token: ${token}  (paste into Foundry: Configure Settings > PTR AI Pilot > AI pilot bridge token)`);
  });
}

/* ------------------------------------------------------------------ *
 *  CLI client
 * ------------------------------------------------------------------ */

async function request(method, route, payload) {
  const token = readToken();
  if (!token) throw new Error("No bridge/.token yet: start the bridge with `node bridge/pilot.mjs serve` first.");
  const res = await fetch(`http://${HOST}:${PORT}${route}`, {
    method,
    headers: { "x-pilot-token": token, "content-type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return res.json();
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : dflt;
  };
  try {
    switch (cmd) {
      case "serve":
        return serve();
      case "token":
        return console.log(readToken({ create: true }));
      case "status":
        return print(await request("GET", "/status"));
      case "wait": {
        // Loops 50 s long-polls until an event arrives or --timeout seconds pass (default: forever).
        const limit = Number(flag("timeout", 0)) * 1000;
        const start = Date.now();
        for (;;) {
          const { events } = await request("GET", "/claude/wait");
          if (events?.length) return print(events);
          if (limit && Date.now() - start >= limit) {
            print([]);
            process.exitCode = 2;
            return;
          }
        }
      }
      case "call": {
        const [name, json] = rest;
        if (!name) throw new Error("usage: call <cmd> [json-args]");
        const args = json ? JSON.parse(json) : {};
        const timeout = Number(flag("timeout", 120));
        const result = await request("POST", "/claude/call", { cmd: name, args, timeout });
        print(result);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      default:
        console.log("usage: node bridge/pilot.mjs serve | status | token | wait [--timeout S] | call <cmd> [json] [--timeout S]");
        process.exitCode = 64;
    }
  } catch (err) {
    console.error(err?.cause?.code === "ECONNREFUSED" ? "Bridge is not running (node bridge/pilot.mjs serve)." : String(err?.message ?? err));
    process.exitCode = 1;
  }
}

main();
