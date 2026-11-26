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

Tokens can be given by token id, actor id or name.

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

Not supported yet: trainer actions (recall, send out, items from the bag).
