/**
 * PTR AI Pilot — standing orders (reactions and interrupts)
 * --------------------------------------------------------
 * Before ending a turn Claude sets orders per piloted token:
 *
 *   call orders '{"token":"Yacuma","list":[
 *     {"when":{"type":"enemyLeavesAdjacent"},"do":{"cmd":"use","args":{"item":"Bite","targets":["$trigger"]}}},
 *     {"when":{"type":"targeted","category":"Physical"},"do":{"cmd":"use","args":{"item":"Protect"}}},
 *     {"when":{"type":"hpBelow","percent":25},"do":{"cmd":"switch","args":{"trainer":"Rival","out":"$self","in":"Gyarados"}}}
 *   ]}'
 *
 * Triggers (`when.type`):
 *   after the fact, checked on the pilot's client:
 *     enemyAdjacent          an enemy ends a move adjacent (≤ 1 m)
 *     enemyLeavesAdjacent    an enemy that was adjacent moves away (Attack of Opportunity)
 *     enemyWithin {range}    an enemy ends a move within `range` m
 *     hpBelow {percent, who} `who` (default: this token) drops below `percent` % HP
 *     allyFaints {who?}      an ally (same disposition), or `who`, faints
 *     enemySendsOut          a hostile Pokémon token appears on the scene
 *   true interrupt, checked before the roll on the attacker's client:
 *     targeted {by?, category?, type?, move?}   this token is targeted by a move
 *
 * `do` is one pilot command (use, move, say, switch, sendOut, recall, target) with its args;
 * the strings "$trigger" and "$self" are replaced by the triggering and the ordering token ids,
 * and `token` defaults to "$self". Orders run with offTurn: true and all the command's checks.
 * `limit`: "once" (default) or "round". Orders are replaced at the start of that token's next
 * turn; the turn event lists what fired.
 *
 * Secrecy: orders live only in the pilot's browser (memory + localStorage), never on actor
 * data, which every client receives. Interrupts work by asking: a client about to use a move on
 * targets sends a socket query; the pilot's client answers only if an order matches.
 */

import {
  MODULE_ID, SOCKET, COMMANDS, findToken, requirePiloted, isPiloted, sceneTokens, cellOf,
  distanceBetween, enabled, bridgeConnected, postEvent, registerTurnExtra, sleep, lower,
} from "./ai-pilot.js";

const Q_INTERRUPT = "ptr-ai-pilot-interrupt?";
const A_ACK = "ptr-ai-pilot-interrupt-ack";
const A_DONE = "ptr-ai-pilot-interrupt-done";
const A_ONLINE = "ptr-ai-pilot-online";
const ACK_WAIT_MS = 700;
const DONE_WAIT_MS = 25_000;
const ONLINE_TTL_MS = 3 * 60_000;

const TRIGGERS = new Set(["enemyAdjacent", "enemyLeavesAdjacent", "enemyWithin", "hpBelow", "allyFaints", "enemySendsOut", "targeted"]);
const DO_CMDS = new Set(["use", "move", "say", "switch", "sendOut", "recall", "target"]);

/* ------------------------------------------------------------------ *
 *  Storage (pilot client)
 * ------------------------------------------------------------------ */

/** tokenId -> { orders: [{id, when, do, limit, firedRound?}], fired: [] } */
let book = new Map();
const storeKey = () => `${MODULE_ID}.orders.${game.world.id}`;

function save() {
  try { localStorage.setItem(storeKey(), JSON.stringify([...book])); } catch {}
}
function load() {
  try { book = new Map(JSON.parse(localStorage.getItem(storeKey()) ?? "[]")); } catch { book = new Map(); }
}

const active = () => enabled() && bridgeConnected() && !!game.combat?.started;

function validate(order, i) {
  const type = order?.when?.type;
  if (!TRIGGERS.has(type)) throw new Error(`Order ${i + 1}: unknown when.type "${type}". Known: ${[...TRIGGERS].join(", ")}.`);
  if (!DO_CMDS.has(order?.do?.cmd)) throw new Error(`Order ${i + 1}: do.cmd must be one of ${[...DO_CMDS].join(", ")}.`);
  if (type === "enemyWithin" && !(Number(order.when.range) > 0)) throw new Error(`Order ${i + 1}: enemyWithin needs a range.`);
  if (type === "hpBelow" && !(Number(order.when.percent) > 0)) throw new Error(`Order ${i + 1}: hpBelow needs a percent.`);
  return {
    id: order.id ?? `o${i + 1}`,
    when: order.when,
    do: { cmd: order.do.cmd, args: order.do.args ?? {} },
    limit: order.limit === "round" ? "round" : "once",
    note: order.note ?? null,
  };
}

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

const disp = (t) => t?.document?.disposition ?? t?.disposition ?? 0;
const isEnemy = (a, b) => disp(a) * disp(b) < 0;
const isAlly = (a, b) => disp(a) !== 0 && disp(a) === disp(b) && a !== b;
const hpPct = (actor) => {
  const h = actor?.system?.health;
  return h?.max ? (h.value / h.max) * 100 : 100;
};
const isFainted = (actor) => (actor?.system?.health?.value ?? 1) <= 0 || !!actor?.conditions?.active?.some?.((c) => c.slug === "fainted");

function substitute(value, self, trigger) {
  if (value === "$self") return self;
  if (value === "$trigger") return trigger ?? self;
  if (Array.isArray(value)) return value.map((v) => substitute(v, self, trigger));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, self, trigger)]));
  return value;
}

/** Last known cell per token, so "leaves adjacent" can compare before/after. */
const lastCell = new Map();
function rememberCells() {
  lastCell.clear();
  for (const t of sceneTokens()) lastCell.set(t.id, cellOf(t));
}
const chebyshev = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));

/* ------------------------------------------------------------------ *
 *  Firing
 * ------------------------------------------------------------------ */

let queue = Promise.resolve();
let firing = false;

function fire(tokenId, order, trigger, reason) {
  const entry = book.get(tokenId);
  if (!entry) return null;
  const round = game.combat?.round ?? 0;
  if (order.limit === "round" && order.firedRound === round) return null;
  if (order.limit === "once") entry.orders = entry.orders.filter((o) => o !== order);
  else order.firedRound = round;
  save();

  const run = queue.then(async () => {
    const fn = COMMANDS[order.do.cmd];
    const args = substitute({ token: "$self", ...order.do.args }, tokenId, trigger?.id ?? null);
    const record = { order: order.id, when: order.when.type, reason, trigger: trigger?.name ?? null, cmd: order.do.cmd, round };
    firing = true;
    try {
      const data = await fn({ ...args, offTurn: true });
      record.ok = true;
      record.result = data;
    } catch (err) {
      record.ok = false;
      record.error = String(err?.message ?? err);
    } finally {
      firing = false;
    }
    entry.fired.push(record);
    save();
    postEvent({ type: "reaction", token: tokenId, actor: canvas.tokens.get(tokenId)?.name ?? null, ...record });
    return record;
  });
  queue = run.catch(() => {});
  return run;
}

function eachOrder(type, fn) {
  if (!active()) return;
  for (const [tokenId, entry] of book) {
    const self = canvas.tokens?.get(tokenId);
    if (!self || !isPiloted(self.actor)) continue;
    for (const order of [...entry.orders]) if (order.when.type === type) fn(self, order);
  }
}

/* ------------------------------------------------------------------ *
 *  After-the-fact triggers (pilot client)
 * ------------------------------------------------------------------ */

function onMoved(tokenDoc) {
  const mover = tokenDoc.object;
  if (!mover) return;
  const before = lastCell.get(mover.id);
  const after = cellOf(mover);
  lastCell.set(mover.id, after);
  if (!active() || (before && before.col === after.col && before.row === after.row)) return;

  eachOrder("enemyAdjacent", (self, order) => {
    if (isEnemy(self, mover) && distanceBetween(self, mover) <= 1) fire(self.id, order, mover, `${mover.name} moved adjacent`);
  });
  eachOrder("enemyWithin", (self, order) => {
    if (isEnemy(self, mover) && distanceBetween(self, mover) <= Number(order.when.range)) fire(self.id, order, mover, `${mover.name} moved within ${order.when.range} m`);
  });
  eachOrder("enemyLeavesAdjacent", (self, order) => {
    if (!before || !isEnemy(self, mover)) return;
    const selfCell = cellOf(self);
    const wasAdjacent = chebyshev(before, selfCell) <= 1;
    if (wasAdjacent && distanceBetween(self, mover) > 1) fire(self.id, order, mover, `${mover.name} moved away`);
  });
}

/** Tokens fainted at the last check, so allyFaints fires on the transition only. */
let faintedBefore = new Set();
function faintedNow() {
  return new Set(sceneTokens().filter((t) => isFainted(t.actor)).map((t) => t.id));
}

function onHealthChange() {
  const now = faintedNow();
  const newlyFainted = new Set([...now].filter((id) => !faintedBefore.has(id)));
  faintedBefore = now;
  if (!active()) return;
  eachOrder("hpBelow", (self, order) => {
    const who = order.when.who ? (() => { try { return findToken(order.when.who); } catch { return null; } })() : self;
    if (who && hpPct(who.actor) < Number(order.when.percent)) fire(self.id, order, who, `${who.name} below ${order.when.percent}% HP`);
  });
  eachOrder("allyFaints", (self, order) => {
    const candidates = order.when.who
      ? [(() => { try { return findToken(order.when.who); } catch { return null; } })()].filter(Boolean)
      : sceneTokens().filter((t) => isAlly(self, t));
    const down = candidates.find((t) => newlyFainted.has(t.id));
    if (down) fire(self.id, order, down, `${down.name} fainted`);
  });
}

function onTokenCreated(tokenDoc) {
  setTimeout(() => {
    const t = tokenDoc.object;
    if (t) lastCell.set(t.id, cellOf(t));
    if (!t || t.actor?.type !== "pokemon") return;
    eachOrder("enemySendsOut", (self, order) => {
      if (isEnemy(self, t)) fire(self.id, order, t, `${t.name} was sent out`);
    });
  }, 300);
}

/* ------------------------------------------------------------------ *
 *  True interrupts
 * ------------------------------------------------------------------ */

const pilotsSeen = new Map(); // userId -> last seen ms
const pending = new Map(); // queryId -> { acked, resolveDone }

function matchesTargeted(order, info) {
  const w = order.when;
  if (w.category && lower(w.category) !== lower(info.category)) return false;
  if (w.type && lower(w.type) !== lower(info.moveType)) return false;
  if (w.move && lower(w.move) !== lower(info.move)) return false;
  if (w.by) {
    const by = lower(w.by);
    if (by !== lower(info.attackerTokenId) && by !== lower(info.attackerName) && by !== lower(info.attackerActorId)) return false;
  }
  return true;
}

/** Pilot client: answer an interrupt query if an order matches. */
async function answerQuery(msg) {
  if (!active() || firing) return;
  const hits = [];
  for (const tokenId of msg.targetTokenIds ?? []) {
    const entry = book.get(tokenId);
    const self = canvas.tokens?.get(tokenId);
    if (!entry || !self || !isPiloted(self.actor)) continue;
    const order = entry.orders.find((o) => o.when.type === "targeted" && matchesTargeted(o, msg) &&
      !(o.limit === "round" && o.firedRound === (game.combat?.round ?? 0)));
    if (order) hits.push({ tokenId, order });
  }
  if (!hits.length) return;
  game.socket.emit(SOCKET, { action: A_ACK, queryId: msg.queryId, to: msg.from });
  const attacker = canvas.tokens?.get(msg.attackerTokenId) ?? { id: msg.attackerTokenId, name: msg.attackerName };
  const results = [];
  for (const { tokenId, order } of hits) {
    results.push(await fire(tokenId, order, attacker, `targeted by ${msg.attackerName}'s ${msg.move}`));
  }
  game.socket.emit(SOCKET, { action: A_DONE, queryId: msg.queryId, to: msg.from, results: results.map((r) => ({ ok: r?.ok, cmd: r?.cmd, error: r?.error })) });
}

/** Attacker client: ask any pilot before a move resolves. */
async function askInterrupts(item, options) {
  if (!enabled() || !game.combat?.started) return;
  const now = Date.now();
  const fresh = [...pilotsSeen].filter(([, t]) => now - t < ONLINE_TTL_MS).map(([u]) => u);
  if (!fresh.length) return;
  // The pilot's own attacks only need asking if another pilot client is around.
  if (isPiloted(item.actor) && !fresh.some((u) => u !== game.user.id)) return;
  const targets = options?.targets?.length ? options.targets : [...game.user.targets];
  const targetTokenIds = targets.map((t) => t?.id ?? t?.document?.id).filter(Boolean);
  if (!targetTokenIds.length) return;
  const attackerToken = item.actor?.getActiveTokens?.(true)?.[0] ?? null;
  const queryId = foundry.utils.randomID();
  const info = {
    action: Q_INTERRUPT, queryId, from: game.user.id, targetTokenIds,
    attackerTokenId: attackerToken?.id ?? null, attackerName: attackerToken?.name ?? item.actor?.name ?? "",
    attackerActorId: item.actor?.id ?? null, move: item.name, category: item.system?.category ?? "", moveType: item.system?.type ?? "",
  };
  const state = { acked: false };
  const done = new Promise((resolve) => { state.resolveDone = resolve; });
  pending.set(queryId, state);
  game.socket.emit(SOCKET, info);
  // Same browser can be the pilot too (GM testing): answer locally.
  if (bridgeConnected()) answerQuery(info);
  await sleep(ACK_WAIT_MS);
  if (state.acked) {
    ui.notifications?.info(`Waiting for the AI pilot's interrupt…`);
    await Promise.race([done, sleep(DONE_WAIT_MS)]);
  }
  pending.delete(queryId);
}

function wrapMoveUse() {
  const cls = CONFIG.PTU?.Item?.documentClasses?.move;
  if (!cls?.prototype?.use || cls.prototype.use.ptrAiPilotWrapped) return;
  const original = cls.prototype.use;
  const wrapped = async function (options = {}) {
    try {
      await askInterrupts(this, options);
      // A target may have been switched out by the interrupt: drop vanished tokens.
      if (options?.targets?.length) options = { ...options, targets: options.targets.filter((t) => t?.document ? !!canvas.tokens.get(t.id) : true) };
    } catch (err) {
      console.error(`${MODULE_ID} | interrupt check failed`, err);
    }
    return original.call(this, options);
  };
  wrapped.ptrAiPilotWrapped = true;
  cls.prototype.use = wrapped;
}

function onSocket(msg) {
  switch (msg?.action) {
    case A_ONLINE:
      pilotsSeen.set(msg.from, Date.now());
      return;
    case Q_INTERRUPT:
      if (msg.from !== game.user.id) answerQuery(msg);
      return;
    case A_ACK:
      if (msg.to === game.user.id) { const p = pending.get(msg.queryId); if (p) p.acked = true; }
      return;
    case A_DONE:
      if (msg.to === game.user.id) pending.get(msg.queryId)?.resolveDone?.(msg.results);
      return;
  }
}

function announceOnline() {
  if (!bridgeConnected() || !enabled()) return;
  game.socket.emit(SOCKET, { action: A_ONLINE, from: game.user.id });
  pilotsSeen.set(game.user.id, Date.now());
}

/* ------------------------------------------------------------------ *
 *  Command + turn report
 * ------------------------------------------------------------------ */

COMMANDS.orders = async ({ token: ref, list }) => {
  const token = findToken(ref);
  requirePiloted(token);
  if (list === undefined) {
    const entry = book.get(token.id);
    return { token: token.name, orders: entry?.orders ?? [], fired: entry?.fired ?? [] };
  }
  if (!Array.isArray(list)) throw new Error("`list` must be an array of orders ([] clears).");
  const orders = list.map(validate);
  book.set(token.id, { orders, fired: book.get(token.id)?.fired ?? [] });
  save();
  rememberCells();
  announceOnline();
  return { token: token.name, set: orders.length, orders };
};

registerTurnExtra((combatant) => {
  const entry = book.get(combatant.tokenId);
  if (!entry) return {};
  const report = { fired: entry.fired, expired: entry.orders.map((o) => ({ id: o.id, when: o.when.type })) };
  book.delete(combatant.tokenId);
  save();
  return { orders: report };
});

/* ------------------------------------------------------------------ *
 *  Registration
 * ------------------------------------------------------------------ */

Hooks.once("setup", wrapMoveUse);

Hooks.once("ready", () => {
  load();
  game.socket?.on(SOCKET, onSocket);
  const resetScene = () => { rememberCells(); faintedBefore = faintedNow(); };
  Hooks.on("canvasReady", resetScene);
  if (canvas?.ready) resetScene();
  Hooks.on("updateToken", (doc, changed) => {
    if ("x" in changed || "y" in changed) setTimeout(() => onMoved(doc), 350);
    if (changed.delta || changed.actorData) setTimeout(onHealthChange, 200);
  });
  Hooks.on("updateActor", (actor, changed) => {
    if (foundry.utils.hasProperty(changed, "system.health")) setTimeout(onHealthChange, 200);
  });
  Hooks.on("createItem", (item) => { if (item.type === "condition") setTimeout(onHealthChange, 200); });
  Hooks.on("createToken", onTokenCreated);
  Hooks.on("deleteToken", (doc) => lastCell.delete(doc.id));
  Hooks.on("deleteCombat", () => { book.clear(); save(); });
  setInterval(announceOnline, 60_000);
  setTimeout(announceOnline, 3000);
});
