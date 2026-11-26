/**
 * PTR AI Pilot — lets Claude Code play chosen combatants through a local bridge
 * ----------------------------------------------------------------------------
 * A Foundry tab on the PC running Claude (normally a player user, e.g. "Claude") turns on the
 * client setting "Connect AI pilot bridge". This script then long-polls bridge/pilot.mjs on
 * localhost for commands, runs them, posts the results back, and posts a `turn` event whenever a
 * piloted combatant's turn starts, which is what wakes Claude.
 *
 * Piloted actors (on the pilot's client): an actor flagged
 * `flags.ptr-ai-pilot.pilot = true`, or, for a non-GM pilot, any actor that user
 * owns explicitly (OWNER in the actor's own permissions, not via "All Players"). A flag of
 * `false` excludes an owned actor. The GM decides the sides per encounter with ownership.
 *
 * Fair play: state shows the pilot's own actors in full, and everyone else only as a player sees
 * them (name, types, HP %, stages, conditions, position).
 *
 * Commands (bridge `call <cmd> <json>`): state, actor, move, use, endTurn, say, target, ping.
 * pilot-switch.js adds party, sendOut, recall, switch; pilot-orders.js adds orders (standing
 * orders / reactions / interrupts). Both register through the exports below.
 *
 * Writes the pilot can't make itself (damage and effects on actors it doesn't own, advancing a
 * turn it isn't allowed to) go over the module socket to the active GM, who runs the exact PTR
 * functions the chat buttons call: applyDamageFromMessage, applyEffectsFromAttack, and the usage
 * effect pipeline. The GM must be online. World setting "Enable AI pilot" (GM) switches it all off.
 */

export const MODULE_ID = "ptr-ai-pilot";
export const SOCKET = `module.${MODULE_ID}`;
const ACTION_RELAY = "ptre1-ai-pilot-relay";
const ACTION_RELAY_RESULT = "ptre1-ai-pilot-relay-result";
const RELAY_TIMEOUT_MS = 20_000;
const SETTING = { enabled: "enabled", connect: "connect", url: "url", token: "token" };
const FLAG = "pilot";

const PTR = {
  damage: "/systems/ptu/src/module/message/damage.js",
  attack: "/systems/ptu/src/module/message/attack.js",
  pipeline: "/systems/ptu/src/module/rules/pipeline.js",
};

// Core Movement Action -> PTR capability (same map as ptr-capability-ruler.js).
const ACTION_TO_CAPABILITY = {
  walk: ["overland"], fly: ["sky", "levitate"], swim: ["swim"], burrow: ["burrow"],
  climb: ["overland"], crawl: ["overland"], jump: ["overland"], blink: ["teleporter"],
  displace: ["teleporter"], "": ["overland"],
};
const STATS = ["atk", "def", "spatk", "spdef", "spd"];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const lower = (s) => String(s ?? "").trim().toLowerCase();
const stripHTML = (html, max = 400) => {
  const text = String(html ?? "").replace(/<[^>]*>/g, " ").replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/* ------------------------------------------------------------------ *
 *  Who is piloted, and lookups
 * ------------------------------------------------------------------ */

export function isPiloted(actor) {
  if (!actor) return false;
  const flag = actor.getFlag?.(MODULE_ID, FLAG) ?? actor.baseActor?.getFlag?.(MODULE_ID, FLAG);
  if (flag === true || flag === false) return flag;
  if (game.user.isGM) return false;
  const ownership = actor.ownership ?? actor.baseActor?.ownership ?? {};
  return (ownership[game.user.id] ?? 0) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
}

export function sceneTokens() {
  return canvas?.tokens?.placeables ?? [];
}

/** Token placeable from a token id, actor id, or (case-insensitive) token/actor name. */
export function findToken(ref) {
  if (!ref) throw new Error("No token given.");
  if (ref?.document?.documentName === "Token") return ref;
  const tokens = sceneTokens();
  const combatIds = new Set(game.combat?.combatants.map((c) => c.tokenId) ?? []);
  const byPriority = (list) => list.sort((a, b) => combatIds.has(b.id) - combatIds.has(a.id))[0];
  const hit =
    tokens.find((t) => t.id === ref) ??
    byPriority(tokens.filter((t) => t.actor?.id === ref)) ??
    byPriority(tokens.filter((t) => lower(t.name) === lower(ref))) ??
    byPriority(tokens.filter((t) => lower(t.actor?.name) === lower(ref)));
  if (!hit) throw new Error(`No token "${ref}" on the viewed scene (${canvas?.scene?.name ?? "none"}).`);
  return hit;
}

function findItem(actor, ref) {
  const items = [...actor.items];
  const r = lower(ref);
  return (
    items.find((i) => i.id === ref) ??
    items.find((i) => i.type === "move" && lower(i.name) === r) ??
    items.find((i) => lower(i.name) === r) ??
    items.find((i) => i.type === "move" && lower(i.system?.slug) === r)
  );
}

/* ------------------------------------------------------------------ *
 *  Geometry
 * ------------------------------------------------------------------ */

export function cellOf(token) {
  const { i, j } = canvas.grid.getOffset({ x: token.document.x, y: token.document.y });
  return { col: j, row: i, w: token.document.width, h: token.document.height };
}

export function occupiedCells(token) {
  const { col, row, w, h } = cellOf(token);
  const cells = [];
  for (let dx = 0; dx < Math.max(1, Math.round(w)); dx++)
    for (let dy = 0; dy < Math.max(1, Math.round(h)); dy++) cells.push({ i: row + dy, j: col + dx });
  return cells;
}

export function cellCenter({ i, j }) {
  return canvas.grid.getCenterPoint({ i, j });
}

/** Closest cell-to-cell grid distance between two tokens, in scene units (metres). */
export function distanceBetween(a, b) {
  let best = Infinity;
  for (const ca of occupiedCells(a))
    for (const cb of occupiedCells(b)) {
      const d = canvas.grid.measurePath([cellCenter(ca), cellCenter(cb)]).distance;
      if (d < best) best = d;
    }
  return Math.round(best * 100) / 100;
}

function capabilities(actor) {
  const caps = actor.system?.capabilities ?? {};
  const out = {};
  for (const [k, v] of Object.entries(caps)) {
    if (typeof v === "number" || (typeof v === "string" && v !== "")) out[k] = v;
  }
  return out;
}

function speedFor(actor, action) {
  const keys = ACTION_TO_CAPABILITY[action ?? ""] ?? ACTION_TO_CAPABILITY[""];
  const caps = actor.system?.capabilities ?? {};
  return Math.max(0, ...keys.map((k) => Number(caps[k])).filter(Number.isFinite));
}

/** First numeric range of a move ("Melee" = 1, "6" / "Range 6" = 6, "Self"/"Burst" = 0). */
function moveRange(item) {
  const raw = String(item.system?.range ?? "");
  const parts = raw.split(",").map((s) => s.trim().toLowerCase());
  if (parts.some((p) => p.startsWith("self") || p.startsWith("burst") || p === "field")) return { reach: 0, raw };
  if (parts.some((p) => p.startsWith("melee"))) return { reach: 1, raw };
  for (const p of parts) {
    const m = /^(?:range\s*)?(\d+)/.exec(p);
    if (m) return { reach: Number(m[1]), raw };
    const shape = /^(?:cone|line|close blast|ranged blast|blast)\s*(\d+)/.exec(p);
    if (shape) return { reach: Number(shape[1]), raw };
  }
  return { reach: null, raw };
}

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */

function stages(actor) {
  const out = {};
  for (const s of STATS) {
    const st = actor.system?.stats?.[s]?.stage;
    const v = (Number(st?.value) || 0) + (Number(st?.mod) || 0);
    if (v) out[s] = v;
  }
  return out;
}

function conditionSlugs(actor) {
  const active = actor.conditions?.active ?? [];
  const slugs = active.map((c) => c.slug ?? c.system?.slug ?? lower(c.name));
  const effects = (actor.itemTypes?.effect ?? []).map((e) => e.slug ?? lower(e.name));
  return [...new Set([...slugs, ...effects])].filter(Boolean);
}

function combatantSummary(c, current) {
  const token = c.token?.object;
  const actor = c.actor;
  if (!actor) return { combatant: c.id, name: c.name, missingActor: true };
  const mine = isPiloted(actor);
  const health = actor.system?.health ?? {};
  const base = {
    combatant: c.id,
    token: c.tokenId,
    actor: actor.id,
    name: c.name,
    piloted: mine,
    side: c.token?.disposition === 1 ? "friendly" : c.token?.disposition === -1 ? "hostile" : "neutral",
    kind: actor.type,
    types: actor.types ?? actor.system?.typing ?? [],
    hpPercent: health.max ? Math.round((health.value / health.max) * 100) : null,
    stages: stages(actor),
    conditions: conditionSlugs(actor),
    defeated: c.isDefeated ?? c.defeated ?? false,
    hasActed: c.hasActed ?? null,
    initiative: c.initiative,
    position: token ? cellOf(token) : null,
  };
  if (current?.token?.object && token && current.id !== c.id) base.distanceFromCurrent = distanceBetween(current.token.object, token);
  if (!mine) return base;
  return {
    ...base,
    level: actor.system?.level?.current ?? null,
    hp: { value: health.value, max: health.max, total: health.total, injuries: health.injuries, temp: actor.system?.tempHp?.value ?? 0 },
    movement: capabilities(actor),
  };
}

function buildState() {
  const combat = game.combat;
  const scene = canvas?.scene;
  const current = combat?.combatant ?? null;
  return {
    pilotUser: game.user.name,
    scene: scene
      ? { name: scene.name, cellsWide: Math.round(scene.dimensions.sceneWidth / scene.grid.size), cellsHigh: Math.round(scene.dimensions.sceneHeight / scene.grid.size), metresPerCell: scene.grid.distance, units: scene.grid.units }
      : null,
    combat: combat
      ? {
          id: combat.id,
          round: combat.round,
          turn: combat.turn,
          started: combat.started,
          current: current ? { combatant: current.id, name: current.name, token: current.tokenId, piloted: isPiloted(current.actor) } : null,
          combatants: combat.turns.map((c) => combatantSummary(c, current)),
        }
      : null,
  };
}

function moveSummary(item, token) {
  const freqType = item.system?.frequency?.type ?? "at-will";
  return {
    id: item.id,
    name: item.name,
    type: item.system?.type,
    category: item.system?.category,
    damageBase: item.system?.damageBase || null,
    ac: item.system?.ac || null,
    range: item.system?.range,
    frequency: freqType,
    actionCost: Object.entries(item.system?.actionCost ?? {}).filter(([, v]) => v).map(([k]) => k),
    ...availability(item),
    effect: stripHTML(item.system?.effect || item.system?.snippet),
  };
}

function availability(item) {
  const freqType = item.system?.frequency?.type;
  const freq = CONFIG.PTU?.data?.frequencies?.[freqType];
  if (freqType === "static") return { available: false, reason: "Static (passive)" };
  if (item.isUsageProhibited?.({ notify: false })) return { available: false, reason: "Prohibited (Frozen, Loafing or Disabled)" };
  let usePP = false;
  try { usePP = game.settings.get("ptu", "variant.usePP"); } catch {}
  if (freq?.limited && !usePP) {
    const max = item.system?.frequency?.max || 1;
    const used = item.flags?.ptu?.used ?? 0;
    if (used >= max) return { available: false, reason: `${freqType}: ${used}/${max} used` };
  }
  if (freq?.eot && (item.flags?.ptu?.eot ?? 0) > 0) return { available: false, reason: "Used too recently (EOT)" };
  return { available: true };
}

function actorDetail(token) {
  const actor = token.actor;
  if (!isPiloted(actor)) throw new Error(`${token.name} is not one of your actors.`);
  const sys = actor.system ?? {};
  const statTotals = Object.fromEntries(["hp", ...STATS].map((s) => [s, sys.stats?.[s]?.total ?? null]));
  const it = actor.itemTypes ?? {};
  return {
    token: token.id,
    actor: actor.id,
    name: token.name,
    kind: actor.type,
    level: sys.level?.current ?? null,
    types: actor.types ?? [],
    nature: sys.nature?.value ?? null,
    hp: { value: sys.health?.value, max: sys.health?.max, injuries: sys.health?.injuries, temp: sys.tempHp?.value ?? 0 },
    stats: statTotals,
    stages: stages(actor),
    evasion: sys.evasion ?? null,
    conditions: conditionSlugs(actor),
    position: cellOf(token),
    movement: capabilities(actor),
    movementAction: token.document.movementAction ?? null,
    moves: (it.move ?? []).map((m) => moveSummary(m, token)),
    abilities: (it.ability ?? []).map((a) => ({ name: a.name, frequency: a.system?.frequency?.type, effect: stripHTML(a.system?.effect || a.system?.snippet, 300) })),
    features: (it.feat ?? []).map((f) => ({ id: f.id, name: f.name, frequency: f.system?.frequency?.type, ...availability(f), effect: stripHTML(f.system?.effect || f.system?.snippet, 300) })),
    items: (it.item ?? []).filter((i) => (i.system?.quantity ?? 1) > 0).map((i) => ({ id: i.id, name: i.name, quantity: i.system?.quantity ?? 1 })),
  };
}

/* ------------------------------------------------------------------ *
 *  GM relay
 * ------------------------------------------------------------------ */

const relayWaiters = new Map();
/** Extra GM-side relay handlers: kind -> async ({ args, sender, from }) => data. */
const RELAY_HANDLERS = new Map();
export function registerRelay(kind, fn) {
  RELAY_HANDLERS.set(kind, fn);
}

export async function relay(kind, args) {
  if (game.user.isGM) return runRelay({ kind, args, from: game.user.id });
  if (!game.users.activeGM) throw new Error("No GM is online to apply this.");
  const requestId = foundry.utils.randomID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      relayWaiters.delete(requestId);
      reject(new Error(`The GM's client did not answer within ${RELAY_TIMEOUT_MS / 1000}s (is ptr-ai-pilot enabled and "Enable AI pilot" on?).`));
    }, RELAY_TIMEOUT_MS);
    relayWaiters.set(requestId, (msg) => {
      clearTimeout(timer);
      msg.ok ? resolve(msg.data) : reject(new Error(msg.error));
    });
    game.socket.emit(SOCKET, { action: ACTION_RELAY, requestId, kind, args, from: game.user.id });
  });
}

async function runRelay({ kind, args, from }) {
  const sender = game.users.get(from);
  const ownMessage = (id) => {
    const message = game.messages.get(id);
    if (!message) throw new Error(`Chat message ${id} not found.`);
    if (message.author?.id !== from) throw new Error("That chat message wasn't made by the requesting user.");
    return message;
  };
  switch (kind) {
    case "damage": {
      const message = ownMessage(args.messageId);
      const { applyDamageFromMessage } = await import(PTR.damage);
      const targets = (message.targets ?? []).filter((t) => t.actor && t.outcome !== "miss" && t.outcome !== "crit-miss");
      if (!targets.length) return { applied: 0 };
      await applyDamageFromMessage({ message, targets, mode: "full" });
      return { applied: targets.length };
    }
    case "attackEffects": {
      const message = ownMessage(args.messageId);
      const { applyEffectsFromAttack } = await import(PTR.attack);
      await applyEffectsFromAttack({ message, targets: message.targets ?? [] });
      return { applied: (message.targets ?? []).length };
    }
    case "usageEffects": {
      // applyEffectsFromUsage reads game.user.targets, which on the GM's client are the GM's.
      // Same pipeline, with the pilot's targets passed explicitly.
      const message = ownMessage(args.messageId);
      const { applyPostAttackEffects, buildItemDomains } = await import(PTR.pipeline);
      const origin = await fromUuid(message.flags?.ptu?.origin?.actor ?? "");
      const item = await fromUuid(message.flags?.ptu?.origin?.item ?? "");
      if (!origin) throw new Error("Usage message has no origin actor.");
      const domains = message.flags?.ptu?.context?.domains ?? ["apply-effects", ...buildItemDomains(item, "apply-effects")];
      const targets = (args.targetUuids ?? []).map((u) => fromUuidSync(u)?.actor).filter(Boolean).map((actor) => ({ actor }));
      await applyPostAttackEffects({
        origin, item, targets, targetDomains: domains, originDomains: domains,
        messageOptions: message.flags?.ptu?.context?.options ?? [], roll: 0,
      });
      return { applied: targets.length };
    }
    case "nextTurn": {
      const combat = game.combats.get(args.combatId);
      if (!combat?.combatant || combat.combatant.id !== args.combatantId) throw new Error("It is no longer that combatant's turn.");
      const actor = combat.combatant.actor;
      if (!actor?.testUserPermission(sender, "OWNER")) throw new Error("The requesting user doesn't own the current combatant.");
      await combat.nextTurn();
      return { round: combat.round, turn: combat.turn };
    }
    default: {
      const handler = RELAY_HANDLERS.get(kind);
      if (!handler) throw new Error(`Unknown relay request "${kind}".`);
      return handler({ args, sender, from });
    }
  }
}

async function onSocket(msg) {
  if (msg?.action === ACTION_RELAY_RESULT) {
    if (msg.to !== game.user.id) return;
    relayWaiters.get(msg.requestId)?.(msg);
    relayWaiters.delete(msg.requestId);
    return;
  }
  if (msg?.action !== ACTION_RELAY) return;
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  const reply = { action: ACTION_RELAY_RESULT, requestId: msg.requestId, to: msg.from };
  try {
    if (!enabled()) throw new Error("The AI pilot is turned off (world setting \"Enable AI pilot\").");
    reply.data = await runRelay(msg);
    reply.ok = true;
  } catch (err) {
    console.error(`${MODULE_ID} | AI pilot relay failed`, err);
    reply.ok = false;
    reply.error = String(err?.message ?? err);
  }
  game.socket.emit(SOCKET, reply);
}

/* ------------------------------------------------------------------ *
 *  Commands
 * ------------------------------------------------------------------ */

export function requirePiloted(token) {
  if (!isPiloted(token.actor)) throw new Error(`${token.name} is not one of your actors.`);
}

export function turnCheck(token, offTurn) {
  const current = game.combat?.combatant;
  if (!game.combat?.started || !current) return null;
  if (current.tokenId === token.id) return null;
  if (offTurn) return `Acting off-turn (it is ${current.name}'s turn).`;
  throw new Error(`It is ${current.name}'s turn, not ${token.name}'s. Pass offTurn: true for interrupts and reactions.`);
}

/** Run fn while recording this user's new chat messages and PTR warnings. */
async function capture(fn) {
  const messages = [];
  const notes = [];
  const hookId = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) messages.push(m); });
  const n = ui.notifications;
  const orig = { warn: n.warn, error: n.error, info: n.info };
  const grab = (level) => function (text, options) {
    notes.push({ level, text: options?.localize ? game.i18n.localize(text) : String(text) });
    return orig[level].call(this, text, options);
  };
  n.warn = grab("warn"); n.error = grab("error"); n.info = grab("info");
  try {
    const result = await fn(messages);
    await sleep(400); // message hooks settle
    return { result, messages, notes };
  } finally {
    Hooks.off("createChatMessage", hookId);
    Object.assign(n, orig);
  }
}

const ctxType = (m) => m.flags?.ptu?.context?.type;

export function hpLine(token) {
  const a = token.actor;
  const h = a?.system?.health ?? {};
  return isPiloted(a)
    ? { name: token.name, hp: h.value, max: h.max, conditions: conditionSlugs(a) }
    : { name: token.name, hpPercent: h.max ? Math.round((h.value / h.max) * 100) : null, conditions: conditionSlugs(a) };
}

async function setTargets(tokens) {
  const ids = tokens.map((t) => t.id);
  if (typeof canvas.tokens.setTargets === "function") canvas.tokens.setTargets(ids);
  else if (typeof game.user.updateTokenTargets === "function") game.user.updateTokenTargets(ids);
  else {
    for (const t of game.user.targets) t.setTarget(false, { releaseOthers: false });
    tokens.forEach((t, i) => t.setTarget(true, { releaseOthers: i === 0 }));
  }
}

export const COMMANDS = {
  /** Whole fight: scene, round/turn and every combatant (own ones in full). */
  async state() {
    return buildState();
  },

  /** One of your actors in full: stats, moves with availability, abilities, items. */
  async actor({ token }) {
    return actorDetail(findToken(token));
  },

  /**
   * Move a token. `to: {col, row}` (top-left cell) or `path: [{col,row}, ...]`. Checks the
   * distance against the movement capability for `action` (walk/fly/swim/burrow/blink; default
   * the token's current action). Walls stop the move where they would for a player.
   */
  async move({ token: ref, to, path, action, force = false, offTurn = false }) {
    const token = findToken(ref);
    requirePiloted(token);
    const warning = turnCheck(token, offTurn);
    const cells = path ?? (to ? [to] : null);
    if (!cells?.length) throw new Error("Give `to: {col,row}` or `path: [{col,row},...]`.");
    const doc = token.document;
    const moveAction = action ?? doc.movementAction ?? "walk";
    const waypoints = cells.map(({ col, row }) => {
      const p = canvas.grid.getTopLeftPoint({ i: row, j: col });
      return { x: p.x, y: p.y, action: moveAction };
    });
    const start = { x: doc.x, y: doc.y };
    const distance = canvas.grid.measurePath([start, ...waypoints].map((p) => ({ x: p.x + (doc.width * canvas.grid.sizeX) / 2, y: p.y + (doc.height * canvas.grid.sizeY) / 2 }))).distance;
    const speed = speedFor(token.actor, moveAction);
    if (!force && distance > speed) throw new Error(`${distance} m is beyond ${token.name}'s ${moveAction} speed of ${speed} m. Pass force: true to move anyway.`);
    const last = cells.at(-1);
    const blocker = sceneTokens().find((t) => t !== token && occupiedCells(t).some((c) => c.i === last.row && c.j === last.col));
    if (blocker && !force) throw new Error(`Cell (${last.col}, ${last.row}) is occupied by ${blocker.name}.`);
    const before = cellOf(token);
    if (typeof doc.move === "function") await doc.move(waypoints, { autoRotate: true, showRuler: false });
    else await doc.update({ x: waypoints.at(-1).x, y: waypoints.at(-1).y });
    await token.movementAnimationPromise?.catch?.(() => {});
    await sleep(150);
    const after = cellOf(token);
    const arrived = after.col === last.col && after.row === last.row;
    return { from: before, to: after, arrived, distance, speed, action: moveAction, ...(arrived ? {} : { note: "Stopped short (wall or blocked path)." }), ...(warning ? { warning } : {}) };
  },

  /**
   * Use a move, feature or item. `targets` are token refs. Rolls with no dialog, then applies
   * damage / effects through the GM exactly as the chat buttons would.
   */
  async use({ token: ref, item: itemRef, targets = [], force = false, offTurn = false, apply = true }) {
    const token = findToken(ref);
    requirePiloted(token);
    const warning = turnCheck(token, offTurn);
    const actor = token.actor;
    const item = findItem(actor, itemRef);
    if (!item) throw new Error(`${token.name} has no move or item "${itemRef}".`);
    const avail = availability(item);
    if (!avail.available && !force) throw new Error(`${item.name} is unavailable: ${avail.reason}.`);

    const targetTokens = targets.map(findToken);
    const ranges = targetTokens.map((t) => ({ name: t.name, distance: distanceBetween(token, t) }));
    if (item.type === "move") {
      const { reach, raw } = moveRange(item);
      if (reach && !force) {
        const far = ranges.filter((r) => r.distance > reach);
        if (far.length) throw new Error(`Out of range (${raw}): ${far.map((r) => `${r.name} at ${r.distance} m`).join(", ")}. Pass force: true to roll anyway.`);
      }
    }

    const before = targetTokens.map(hpLine);
    await setTargets(targetTokens);
    token.control({ releaseOthers: true });

    // eventToRollParams: skipDialog = shiftKey ? !setting : setting  ->  always skip.
    const event = { shiftKey: !game.settings.get("ptu", "skipRollDialog"), ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, stopPropagation() {} };
    const { messages, notes } = await capture(async (messages) => {
      await item.use({ event, targets: targetTokens.length ? targetTokens : undefined });
      // Damaging move with autoRollDamage off: roll damage as the chat button would.
      const attackMsg = messages.find((m) => ctxType(m) === "attack-roll");
      const hasHit = (attackMsg?.targets ?? []).some((t) => t.outcome === "hit" || t.outcome === "crit-hit");
      if (item.type === "move" && item.isDamaging && attackMsg && hasHit && !messages.some((m) => ctxType(m) === "damage-roll")) {
        await sleep(200);
        if (!messages.some((m) => ctxType(m) === "damage-roll")) {
          await item.damage({ event, options: attackMsg.context?.options ?? [], targets: attackMsg.targets, rollResult: attackMsg.context?.rollResult ?? null });
        }
      }
    });

    const attackMsg = messages.find((m) => ctxType(m) === "attack-roll");
    const damageMsg = messages.find((m) => ctxType(m) === "damage-roll");
    const usageMsg = messages.find((m) => ctxType(m) === "usage");
    const result = { item: item.name, ranges, ...(warning ? { warning } : {}) };
    if (notes.length) result.notices = notes;
    if (!messages.length) {
      result.used = false;
      result.note = "Nothing was rolled or posted (see notices).";
      return result;
    }
    result.used = true;
    if (attackMsg) {
      result.accuracy = {
        roll: attackMsg.rolls?.[0]?.total ?? null,
        outcomes: (attackMsg.targets ?? []).map((t) => ({ name: t.token?.name ?? t.actor?.name, outcome: t.outcome })),
      };
    }
    if (damageMsg) result.damageRoll = { normal: damageMsg.rolls?.[0]?.total ?? null, crit: damageMsg.rolls?.[1]?.total ?? null };

    if (apply) {
      try {
        if (damageMsg) result.applied = { damage: await relay("damage", { messageId: damageMsg.id }) };
        else if (attackMsg && !(item.type === "move" && item.isDamaging)) result.applied = { effects: await relay("attackEffects", { messageId: attackMsg.id }) };
        else if (usageMsg) {
          const targetUuids = (targetTokens.length ? targetTokens : [token]).map((t) => t.document.uuid);
          result.applied = { effects: await relay("usageEffects", { messageId: usageMsg.id, targetUuids }) };
        }
      } catch (err) {
        result.applyError = String(err?.message ?? err);
      }
      await sleep(300);
    }
    result.targets = targetTokens.map((t, i) => ({ before: before[i], after: hpLine(t) }));
    result.self = hpLine(token);
    return result;
  },

  /** End the current piloted combatant's turn. */
  async endTurn() {
    const combat = game.combat;
    const current = combat?.combatant;
    if (!combat?.started || !current) throw new Error("No combat is running.");
    if (!isPiloted(current.actor)) throw new Error(`It is ${current.name}'s turn, which isn't one of yours.`);
    const from = { round: combat.round, turn: combat.turn, name: current.name };
    const advanced = () => combat.round !== from.round || combat.turn !== from.turn;
    try {
      if (combat.canUserModify(game.user, "update")) await combat.nextTurn();
    } catch {}
    await sleep(200);
    if (!advanced()) await relay("nextTurn", { combatId: combat.id, combatantId: current.id });
    await sleep(200);
    return { ended: from, now: { round: combat.round, turn: combat.turn, name: combat.combatant?.name ?? null } };
  },

  /** In-character chat line from a token. */
  async say({ token: ref, text }) {
    const token = findToken(ref);
    requirePiloted(token);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ token: token.document }),
      content: `<p>${foundry.utils.escapeHTML(String(text ?? ""))}</p>`,
      style: CONST.CHAT_MESSAGE_STYLES?.IC,
    });
    return { said: text };
  },

  /** Set (or clear, with []) this user's targets without using anything. */
  async target({ targets = [] }) {
    const tokens = targets.map(findToken);
    await setTargets(tokens);
    return { targets: tokens.map((t) => t.name) };
  },

  /** Round trip check. */
  async ping() {
    return { pong: true, user: game.user.name, world: game.world.title, scene: canvas?.scene?.name ?? null };
  },
};

/* ------------------------------------------------------------------ *
 *  Bridge connection (pilot client only)
 * ------------------------------------------------------------------ */

let loopId = 0;
let connectedNow = false;
let badge = null;

export function enabled() {
  return setting("enabled") !== false;
}

function setting(key) {
  try { return game.settings.get(MODULE_ID, SETTING[key]); } catch { return null; }
}

function setStatus(connected) {
  if (connected !== connectedNow) {
    connectedNow = connected;
    ui.notifications?.[connected ? "info" : "warn"](`AI pilot bridge ${connected ? "connected" : "disconnected"}.`);
  }
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "ptre1-ai-pilot-badge";
    badge.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:100;padding:2px 8px;border-radius:4px;font-size:12px;color:#fff;pointer-events:none;";
    document.body.append(badge);
  }
  badge.textContent = connected ? "AI pilot: connected" : "AI pilot: waiting for bridge";
  badge.style.background = connected ? "rgba(40,130,60,.85)" : "rgba(160,110,30,.85)";
}

function clearStatus() {
  badge?.remove();
  badge = null;
  connectedNow = false;
}

function bridgeFetch(path, init = {}) {
  const base = String(setting("url") || "http://127.0.0.1:47321").replace(/\/+$/, "");
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-pilot-token": String(setting("token") ?? "").trim(), ...(init.headers ?? {}) },
  });
}

export function bridgeConnected() {
  return connectedNow;
}

export async function postEvent(event) {
  if (!connectedNow) return;
  try {
    await bridgeFetch("/foundry/event", { method: "POST", body: JSON.stringify(event) });
  } catch (err) {
    console.warn(`${MODULE_ID} | AI pilot: could not post event`, err);
  }
}

async function runCommand({ id, cmd, args }) {
  let reply;
  try {
    const fn = COMMANDS[cmd];
    if (!fn) throw new Error(`Unknown command "${cmd}". Known: ${Object.keys(COMMANDS).join(", ")}.`);
    reply = { id, ok: true, data: await fn(args ?? {}) };
  } catch (err) {
    reply = { id, ok: false, error: String(err?.message ?? err) };
  }
  try {
    await bridgeFetch("/foundry/result", { method: "POST", body: JSON.stringify(reply) });
  } catch (err) {
    console.error(`${MODULE_ID} | AI pilot: could not post result`, err);
  }
}

async function pollLoop(myId) {
  const qs = `?user=${encodeURIComponent(game.user.name)}&world=${encodeURIComponent(game.world.title)}`;
  while (myId === loopId) {
    try {
      const res = await bridgeFetch(`/foundry/poll${qs}`);
      if (res.status === 401) throw new Error("bad token");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const wasConnected = connectedNow;
      setStatus(true);
      if (!wasConnected) announceTurn(); // already a pilot turn when the bridge comes up
      for (const command of await res.json()) {
        if (myId !== loopId) break;
        await runCommand(command);
      }
    } catch (err) {
      if (myId !== loopId) break;
      setStatus(false);
      if (String(err?.message) === "bad token") console.warn(`${MODULE_ID} | AI pilot: the bridge rejected the token (Configure Settings > AI pilot bridge token).`);
      await sleep(5000);
    }
  }
}

function restartLoop() {
  loopId++;
  const on = enabled() && setting("connect");
  if (!on) return clearStatus();
  setStatus(false);
  pollLoop(loopId);
}

/* ------------------------------------------------------------------ *
 *  Turn events
 * ------------------------------------------------------------------ */

let lastAnnounced = null;
/** Providers of extra turn-event data: (combatant) => object merged into the event. */
const TURN_EXTRAS = [];
export function registerTurnExtra(fn) {
  TURN_EXTRAS.push(fn);
}

function announceTurn() {
  if (!connectedNow || !enabled()) return;
  const combat = game.combat;
  const current = combat?.combatant;
  if (!combat?.started || !current || !isPiloted(current.actor)) return;
  const key = `${combat.id}:${combat.round}:${combat.turn}:${current.id}`;
  if (key === lastAnnounced) return;
  lastAnnounced = key;
  const extras = {};
  for (const fn of TURN_EXTRAS) {
    try { Object.assign(extras, fn(current)); } catch (err) { console.error(`${MODULE_ID} | turn extra failed`, err); }
  }
  postEvent({ type: "turn", actor: current.name, token: current.tokenId, round: combat.round, turn: combat.turn, ...extras, state: buildState() });
}

/* ------------------------------------------------------------------ *
 *  Registration
 * ------------------------------------------------------------------ */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING.enabled, {
    name: "Enable AI pilot",
    hint: "Master switch for the whole world. Off disconnects every bridge and stops the GM applying damage and effects for the pilot.",
    scope: "world", config: true, type: Boolean, default: true, restricted: true,
    onChange: () => restartLoop(),
  });
  game.settings.register(MODULE_ID, SETTING.connect, {
    name: "Connect AI pilot bridge (this browser only)",
    hint: "Turn on only in the Foundry tab Claude plays from, on the PC running the bridge (node bridge/pilot.mjs serve). It lets Claude control the actors this user owns in combat.",
    scope: "client", config: true, type: Boolean, default: false,
    onChange: () => restartLoop(),
  });
  game.settings.register(MODULE_ID, SETTING.url, {
    name: "AI pilot bridge address",
    hint: "Where the bridge listens. Default http://127.0.0.1:47321.",
    scope: "client", config: true, type: String, default: "http://127.0.0.1:47321",
    onChange: () => restartLoop(),
  });
  game.settings.register(MODULE_ID, SETTING.token, {
    name: "AI pilot bridge token",
    hint: "The token the bridge prints when it starts (also in bridge/.token).",
    scope: "client", config: true, type: String, default: "",
    onChange: () => restartLoop(),
  });

  const module = game.modules.get(MODULE_ID);
  module.api = {
    isPiloted,
    state: buildState,
    run: (cmd, args) => COMMANDS[cmd]?.(args ?? {}),
    reconnect: restartLoop,
  };
});

Hooks.once("ready", () => {
  game.socket?.on(SOCKET, onSocket);
  restartLoop();
  Hooks.on("updateCombat", (combat, changed) => {
    if (combat !== game.combat) return;
    if ("turn" in changed || "round" in changed) setTimeout(announceTurn, 250);
  });
  Hooks.on("combatStart", () => setTimeout(announceTurn, 250));
  Hooks.on("deleteCombat", (combat) => {
    if (!connectedNow) return;
    if (combat.combatants.some((c) => isPiloted(c.actor))) postEvent({ type: "combat-end", combat: combat.id });
  });
});

