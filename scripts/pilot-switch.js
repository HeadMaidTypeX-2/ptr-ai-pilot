/**
 * PTR AI Pilot — party, send out, recall, switch
 * ----------------------------------------------
 * PTR has no send-out/recall of its own (you drag tokens). Here:
 *   sendOut = create the Pokémon's token on a cell near its trainer (+ add it to combat)
 *   recall  = delete the Pokémon's token (+ its combatants)
 * Pokémon Assets, when active, animates both on token create/delete (ball throw / return).
 *
 * Party = PTR's own: Pokémon in a "Party" folder inside the trainer's folder if there is one,
 * else Pokémon whose flags.ptu.party.trainer is the trainer and that aren't boxed
 * (same order as PTR's Party screen, apps/party/sheet.js).
 *
 * Range and action cost are GM world settings. PTR keeps CORE's base switching rules (the PTR
 * wiki only adds features such as Quick Switch / Emergency Release), so the defaults (8 m,
 * Standard Action) are placeholders until the GM confirms them from the CORE book. The pilot
 * does not track action economy; the action cost is reported for Claude and the GM.
 *
 * Token/combatant creation and deletion always go through the GM's client (relay), which
 * re-checks party membership, ownership and range.
 */

import {
  MODULE_ID, COMMANDS, findToken, requirePiloted, turnCheck, relay, registerRelay,
  sceneTokens, cellOf, occupiedCells, cellCenter, isPiloted, sleep,
} from "./ai-pilot.js";

const S = {
  recallRange: "switch.recallRange",
  releaseRange: "switch.releaseRange",
  actionCost: "switch.actionCost",
  addToCombat: "switch.addToCombat",
  rollInitiative: "switch.rollInitiative",
};
const get = (k) => game.settings.get(MODULE_ID, S[k]);

/* ------------------------------------------------------------------ *
 *  Party
 * ------------------------------------------------------------------ */

/** The trainer's party Pokémon actors (world actors). */
export function partyOf(trainer) {
  const partyFolder = trainer.folder?.children?.find?.((c) => (c.folder ?? c).name === "Party");
  const folder = partyFolder?.folder ?? partyFolder;
  if (folder?.contents) return folder.contents.filter((a) => a.type === "pokemon");
  return game.actors.filter((a) => a.type === "pokemon" && a.flags?.ptu?.party?.trainer === trainer.id && !a.flags?.ptu?.party?.boxed);
}

/** The trainer actor of a Pokémon (flag first, then a Party folder's parent folder owner). */
export function trainerOf(pokemon) {
  const base = pokemon.baseActor ?? pokemon;
  const id = base.flags?.ptu?.party?.trainer;
  if (id && game.actors.get(id)) return game.actors.get(id);
  const folder = base.folder;
  if (folder?.name === "Party" && folder.folder) {
    return folder.folder.contents?.find((a) => a.type === "character") ?? null;
  }
  return null;
}

const fainted = (actor) => (actor.system?.health?.value ?? 1) <= 0 || !!actor.conditions?.active?.some?.((c) => c.slug === "fainted");

function tokenOfActor(actor, scene = canvas.scene) {
  return scene?.tokens.find((t) => t.actorId === actor.id) ?? null;
}

/** Grid distance from any cell of a token to one cell. */
function distanceToCell(token, { col, row }) {
  let best = Infinity;
  for (const c of occupiedCells(token)) {
    const d = canvas.grid.measurePath([cellCenter(c), cellCenter({ i: row, j: col })]).distance;
    if (d < best) best = d;
  }
  return Math.round(best * 100) / 100;
}

function cellFree({ col, row }, except = null) {
  return !sceneTokens().some((t) => t !== except && occupiedCells(t).some((c) => c.i === row && c.j === col));
}

function trainerToken(ref) {
  const token = findToken(ref);
  requirePiloted(token);
  if (token.actor?.type !== "character") throw new Error(`${token.name} is not a trainer.`);
  return token;
}

function partyMember(trainer, ref) {
  const r = String(ref ?? "").trim().toLowerCase();
  const mon = partyOf(trainer).find((a) => a.id === ref || a.name.toLowerCase() === r);
  if (!mon) throw new Error(`${trainer.name} has no party Pokémon "${ref}". Use the party command to list them.`);
  return mon;
}

/* ------------------------------------------------------------------ *
 *  GM side
 * ------------------------------------------------------------------ */

registerRelay("sendOut", async ({ args, sender }) => {
  const scene = game.scenes.get(args.sceneId);
  const trainer = scene?.tokens.get(args.trainerTokenId)?.actor;
  const mon = game.actors.get(args.actorId);
  if (!scene || !trainer || !mon) throw new Error("Scene, trainer or Pokémon not found.");
  if (!trainer.testUserPermission(sender, "OWNER")) throw new Error("The requesting user doesn't own that trainer.");
  if (!partyOf(trainer).includes(mon)) throw new Error(`${mon.name} is not in ${trainer.name}'s party.`);
  if (scene.tokens.some((t) => t.actorId === mon.id)) throw new Error(`${mon.name} is already on the field.`);
  const td = await mon.getTokenDocument({ x: args.x, y: args.y });
  const [created] = await scene.createEmbeddedDocuments("Token", [td.toObject()]);
  const out = { token: created.id, name: created.name };
  const combat = game.combats.get(args.combatId);
  if (combat && get("addToCombat")) {
    const [cbt] = await combat.createEmbeddedDocuments("Combatant", [{ tokenId: created.id, sceneId: scene.id, actorId: mon.id }]);
    out.combatant = cbt.id;
    if (get("rollInitiative")) {
      await combat.rollInitiative([cbt.id]);
      out.initiative = combat.combatants.get(cbt.id)?.initiative ?? null;
    }
  }
  return out;
});

registerRelay("recall", async ({ args, sender }) => {
  const scene = game.scenes.get(args.sceneId);
  const token = scene?.tokens.get(args.tokenId);
  if (!token?.actor) throw new Error("That Pokémon's token is gone.");
  if (token.actor.type !== "pokemon") throw new Error("Only Pokémon can be recalled.");
  if (!token.actor.testUserPermission(sender, "OWNER")) throw new Error("The requesting user doesn't own that Pokémon.");
  for (const combat of game.combats) {
    const ids = combat.combatants.filter((c) => c.tokenId === token.id && c.sceneId === scene.id).map((c) => c.id);
    if (ids.length) await combat.deleteEmbeddedDocuments("Combatant", ids);
  }
  await token.delete();
  return { recalled: token.name };
});

/* ------------------------------------------------------------------ *
 *  Commands (pilot client)
 * ------------------------------------------------------------------ */

async function doSendOut({ trainer: tRef, pokemon, to, force = false, offTurn = false, allowFainted = false }) {
  const tToken = trainerToken(tRef);
  const warning = turnCheck(tToken, offTurn);
  const mon = partyMember(tToken.actor, pokemon);
  if (tokenOfActor(mon)) throw new Error(`${mon.name} is already on the field.`);
  if (fainted(mon) && !allowFainted) throw new Error(`${mon.name} is fainted.`);
  if (!to) throw new Error("Give `to: {col,row}` for where to send it out.");
  const range = get("releaseRange");
  const distance = distanceToCell(tToken, to);
  if (!force && range > 0 && distance > range) throw new Error(`(${to.col}, ${to.row}) is ${distance} m from ${tToken.name}; release range is ${range} m. Pass force: true to ignore.`);
  if (!cellFree(to)) throw new Error(`Cell (${to.col}, ${to.row}) is occupied.`);
  const p = canvas.grid.getTopLeftPoint({ i: to.row, j: to.col });
  const result = await relay("sendOut", {
    sceneId: canvas.scene.id, trainerTokenId: tToken.id, actorId: mon.id, x: p.x, y: p.y,
    combatId: game.combat?.started ? game.combat.id : null,
  });
  await sleep(300);
  return { sentOut: mon.name, at: to, distance, actionCost: get("actionCost"), ...result, ...(warning ? { warning } : {}) };
}

async function doRecall({ pokemon, force = false, offTurn = false }) {
  const token = findToken(pokemon);
  requirePiloted(token);
  if (token.actor?.type !== "pokemon") throw new Error(`${token.name} is not a Pokémon.`);
  const trainer = trainerOf(token.actor);
  if (!trainer) throw new Error(`${token.name} has no trainer (flags.ptu.party).`);
  const tDoc = tokenOfActor(trainer);
  if (!tDoc?.object) throw new Error(`${trainer.name} is not on this scene, so ${token.name} can't be recalled.`);
  const warning = turnCheck(tDoc.object, offTurn);
  const range = get("recallRange");
  const distance = distanceToCell(tDoc.object, cellOf(token));
  if (!force && range > 0 && distance > range) throw new Error(`${token.name} is ${distance} m from ${trainer.name}; recall range is ${range} m. Pass force: true to ignore.`);
  const at = cellOf(token);
  const result = await relay("recall", { sceneId: canvas.scene.id, tokenId: token.id });
  await sleep(300);
  return { ...result, from: at, distance, trainer: trainer.name, actionCost: get("actionCost"), ...(warning ? { warning } : {}) };
}

Object.assign(COMMANDS, {
  /** A trainer's party: on field or not, fainted, HP, distance from the trainer. */
  async party({ trainer: tRef }) {
    const tToken = trainerToken(tRef);
    return {
      trainer: tToken.name,
      recallRange: get("recallRange"),
      releaseRange: get("releaseRange"),
      actionCost: get("actionCost"),
      pokemon: partyOf(tToken.actor).map((a) => {
        const t = tokenOfActor(a);
        const h = a.system?.health ?? {};
        return {
          actor: a.id, name: a.name, level: a.system?.level?.current ?? null, types: a.types ?? [],
          hp: { value: h.value, max: h.max }, fainted: fainted(a),
          onField: !!t, token: t?.id ?? null,
          ...(t?.object ? { position: cellOf(t.object), distanceFromTrainer: distanceToCell(tToken, cellOf(t.object)) } : {}),
        };
      }),
    };
  },

  /** Send a party Pokémon out to `to: {col,row}` within release range. */
  sendOut: doSendOut,

  /** Recall a Pokémon within recall range of its trainer. */
  recall: doRecall,

  /** Recall `out` and send `in` out to the same cell. */
  async switch({ trainer: tRef, out, in: incoming, force = false, offTurn = false, allowFainted = false }) {
    const outToken = findToken(out);
    const at = cellOf(outToken);
    const recalled = await doRecall({ pokemon: out, force, offTurn });
    const sent = await doSendOut({ trainer: tRef, pokemon: incoming, to: { col: at.col, row: at.row }, force: true, offTurn, allowFainted });
    return { recalled, sentOut: sent };
  },
});

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MODULE_ID, S[key], { scope: "world", config: true, restricted: true, ...data });
  reg("recallRange", {
    name: "AI pilot: recall range (m)",
    hint: "Maximum distance from trainer to Pokémon for a recall. PTR keeps the CORE rule; set it from the CORE book. 0 = no limit.",
    type: Number, default: 8,
  });
  reg("releaseRange", {
    name: "AI pilot: release range (m)",
    hint: "Maximum distance from trainer to the cell a Pokémon is sent out to. PTR keeps the CORE rule; set it from the CORE book. 0 = no limit.",
    type: Number, default: 8,
  });
  reg("actionCost", {
    name: "AI pilot: switching action cost",
    hint: "Reported to the pilot after a recall/send out (it does not track actions). Features like Quick Switch override it in a battle brief.",
    type: String, default: "Standard Action (CORE baseline, unverified)",
  });
  reg("addToCombat", {
    name: "AI pilot: add sent-out Pokémon to combat",
    type: Boolean, default: true,
  });
  reg("rollInitiative", {
    name: "AI pilot: roll initiative for sent-out Pokémon",
    type: Boolean, default: true,
  });
});
