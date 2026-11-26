# PTR AI Pilot

Lets Claude Code play chosen combatants in a Foundry VTT **PTR** world (system id `ptu`,
4.4.3.57+, Foundry V13/V14). It reads the fight, moves tokens, uses moves and items through
PTR's own roll pipeline, and ends its own turns. It's for playtesting boss fights and encounters.

Manifest:
```
https://github.com/HeadMaidTypeX-2/ptr-ai-pilot/releases/latest/download/module.json
```

## How it fits together

```
Foundry server (any machine) ── normal connection ── Foundry tab on the PC running Claude Code
                                                        │ long-polls http://127.0.0.1:47321
                                                        ▼
                                          bridge/pilot.mjs  ◄── Claude Code (CLI calls)
```

The module runs in every client. Only the tab with **Connect AI pilot bridge** turned on talks
to the bridge. The other clients only take part as the GM relay (see below).

## Setup

1. Install the module in the world and enable it. The GM client must have it too.
2. Create a player user for the pilot (e.g. "Claude"). Give it **explicit Owner** on the actors
   it should play. "All Players" ownership doesn't count. To include or exclude an actor
   explicitly, set `flags.ptr-ai-pilot.pilot` to true or false. Use the flag when the pilot is a
   GM.
3. On the PC running Claude Code, run `node bridge/pilot.mjs serve` (Node 18+, no installs). It
   prints a token, which is also saved in `bridge/.token`.
   **If Foundry is served from another machine**, Chrome won't let that page call `127.0.0.1`
   (Local Network Access). Bind to this PC's LAN address instead with
   `PILOT_HOST=192.168.x.y node bridge/pilot.mjs serve`, and use the same `PILOT_HOST` for CLI
   calls. Set the Foundry "AI pilot bridge address" to `http://192.168.x.y:47321`. Allow Node
   through Windows Firewall on private networks if asked.
4. Use a normal Chrome/Edge/Firefox tab. Embedded app browsers may block local-network requests
   entirely. In the pilot's Foundry tab, open *Configure Settings* for that browser, turn on **Connect AI
   pilot bridge** and paste the token. A badge at the bottom-left shows the connection.
   Chrome may ask once to allow the page to reach the local network.

## Playing

- `node bridge/pilot.mjs status` shows whether a tab is connected.
- `node bridge/pilot.mjs wait` blocks until a piloted combatant's turn starts. It prints the
  `turn` event, which includes the fight state.
- `node bridge/pilot.mjs call <cmd> '<json>'` runs a command in the tab:

| Command | Args | Does |
|---|---|---|
| `state` | – | Scene, round/turn and every combatant. Own actors appear in full; others show HP %, types, stages, conditions and position. |
| `actor` | `token` | One own actor in full: stats, evasion, moves (with availability), abilities, features, items. |
| `move` | `token`, `to: {col,row}` or `path`, `action?`, `force?` | Moves the token, checked against its movement capability. Walls stop it. |
| `use` | `token`, `item`, `targets: [...]`, `force?`, `offTurn?`, `apply?` | Uses a move or item with no roll dialog, then applies damage and effects. Frequency and range are checked first. |
| `endTurn` | – | Advances the tracker if it is a piloted combatant's turn. |
| `say` | `token`, `text` | In-character chat line. |
| `target` | `targets` | Sets targets only. |
| `ping` | – | Round trip check. |
| `party` | `trainer` | The trainer's party Pokémon: on field or not, fainted, HP, distance from the trainer. |
| `sendOut` | `trainer`, `pokemon`, `to: {col,row}`, `force?`, `offTurn?` | Places the Pokémon's token within release range and adds it to combat. |
| `recall` | `pokemon`, `force?`, `offTurn?` | Removes the token and its combatant, if within recall range of its trainer. |
| `switch` | `trainer`, `out`, `in` | Recall `out`, send `in` out to the same cell. |
| `orders` | `token`, `list?` | Sets this token's standing orders (`[]` clears; no `list` shows them). |
| `struggle` | `token`, `target?`, `reason?` | Whispers the GM to resolve a Struggle Attack (e.g. an Attack of Opportunity). The pilot can't use PTR's runtime Struggle items yet. |

Tokens can be given by token id, actor id or name.

## Switching Pokémon

PTR has no send-out or recall of its own, so `sendOut` creates the Pokémon's token and
`recall` deletes it. Pokémon Assets, when active, animates both. Your GM client makes the change
after re-checking party membership, ownership and range.

The party is PTR's own: a `Party` folder inside the trainer's folder, else Pokémon whose
`flags.ptu.party.trainer` is the trainer and that aren't boxed.

The rules come from the PTR rulebook that ships in the system (Pokémon Switching):
- **Recall range** is the Poké Ball's recall beam, 8 m. It doesn't apply in League Battles
  (PTR's `leagueBattle` setting).
- **Release range** isn't stated in the rules, so the default is no limit.
- **Action cost:** a full Switch is a Standard Action, Recall or Release alone a Shift Action each,
  and switching out a Fainted Pokémon a Shift Action.

All three are GM world settings. The pilot reports the action cost but doesn't track action
economy.

## Standing orders (reactions and interrupts)

Before ending a turn, the pilot can leave orders: **when** something happens, **do** one command
(`use`, `move`, `say`, `struggle`, `switch`, `sendOut`, `recall`, `target`). In the order's
arguments, `$trigger` stands for the triggering token and `$self` for the token that set it.
`limit` is `"once"` (the default) or `"round"`.

**Action rules** (PTR rulebook and maneuver items in the system packs). Each order has a `kind`:
- **`aoo`** (Attack of Opportunity): **once per round**, and not while Sleeping, Flinched or
  Paralyzed. It's a Struggle Attack, so its natural action is `struggle`. This is the default for
  `enemyLeavesAdjacent` orders.
- **`interrupt`**: **no per-round cap**, but it's only that one action. Before the combatant's
  turn, it spends that round's Standard Action. After its turn, it gives up its turn next round;
  the turn event says so and the GM gets a whisper. This is the default for every other order.
- **`free`** (or `free: true`): no cost. Cite the feature that allows it, e.g. Quick Switch.

If several orders match one event, they are tried **in list order**, so put the most important
first. An order whose action fails (out of range, unavailable…) is refunded.

| `when.type` | Fires |
|---|---|
| `enemyAdjacent` | An enemy ends a move adjacent. |
| `enemyLeavesAdjacent` | An adjacent enemy moves away (Attack of Opportunity). |
| `enemyWithin` `{range}` | An enemy ends a move within `range` m. |
| `hpBelow` `{percent, who?}` | The token, or `who`, is below `percent` % HP. |
| `allyFaints` `{who?}` | An ally, or `who`, faints. |
| `enemySendsOut` | A hostile Pokémon is sent out. |
| `roundStart` | A new round begins, for Priority-style declarations. PTR's Priority and Interrupt ordering is the GM's call. |
| `targeted` `{by?, category?, type?, move?}` | **Interrupt.** Before the roll, the attacker's client pauses for up to 25 s while the order runs. |

Orders only take effect while combat is running and the bridge is connected. They are replaced
at the start of that token's next turn, and the turn event reports what fired. Each firing also
posts a `reaction` event.

**Secrecy.** Orders live only in the pilot's browser (memory and `localStorage`), never on
actor data, which every client receives.

**Interrupts.** The interrupt hook wraps PTR's `PTUMove.use`, which the sheet and token panel
call. Rolls made any other way skip it. If an interrupt switches out the target, the attack
continues against the remaining targets; the GM adjudicates the rest.

## Battle briefs

Write how a piloted actor should fight (persona, goals, tactics, triggers, voice lines) in
`briefs/<name>.md`, starting from [`briefs/_template.md`](briefs/_template.md). The pilot reads
the matching brief before each turn and writes a fight log to `briefs/logs/` afterwards. Briefs
and logs are git-ignored so boss tactics never reach the public repo. See
[`briefs/README.md`](briefs/README.md).

## GM relay

PTR has no way to forward a player's writes to the GM. Without one, a player can't apply damage
to an actor it doesn't own. So the pilot sends a socket request to the **active GM**, and the
GM's client runs the same functions as the chat Apply buttons: `applyDamageFromMessage`,
`applyEffectsFromAttack`, and the usage effect pipeline. A turn advance the pilot isn't allowed
to make goes the same way. **A GM must be online.** The GM only accepts requests for chat
messages the requesting user made, and turn advances for combatants that user owns.

The world setting **Enable AI pilot** (GM only) switches everything off.

## Security

The bridge listens on 127.0.0.1 by default, or on the LAN address given in `PILOT_HOST`, which
anyone on your network can reach. Either way, it requires the token on every request. Only the
`/foundry/*` routes answer browser CORS requests. `bridge/.token` is git-ignored.

## Status

Tested in play on Foundry V14 with PTR 4.4.3.57. Working: turn wake-up, movement with the
capability check, move use with no dialog, effects applied through the GM relay, in-character
chat, and ending turns.

Added after that test, and not yet tested in play: party, send out, recall and switch; standing orders and interrupts.

Not supported yet: Struggle attacks (PTR builds them at runtime); bag items on others are untested, and PTR doesn't reduce their quantity.
