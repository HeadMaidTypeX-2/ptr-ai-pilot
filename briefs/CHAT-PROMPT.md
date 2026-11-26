# Prompt for Claude Chat: drafting a battle brief

Paste everything below the line into your Chat project, followed by the contents of
`_template.md` and the encounter material listed at the end.

---

I need a **battle brief** for an AI pilot that plays combatants in our Foundry VTT game (PTR e1,
system `ptu`). The pilot is Claude Code. It reads this brief before each of its turns and has
none of this project's context, so the brief must stand on its own. Fill in the template I paste
below. Keep it practical: the pilot follows instructions literally.

**What the pilot can do on a turn**
- **Move a token** on a square grid (1 cell = 1 m). Diagonals alternate 1 m / 2 m. The move is
  limited by the actor's movement capability (Overland, Swim, Sky…), and walls stop it.
- **Use a move**, with a target or targets. The system rolls accuracy and damage and applies
  them. The pilot refuses moves that are out of range or past their frequency (EOT, Scene,
  Daily).
- **Use a feature or an owned item.** This exists but hasn't been tested in play yet.
- **Say one in-character chat line.**
- **End its turn.**

**What it can't do (yet)**
- **Recall or send out a Pokémon**, or use items from a trainer's bag on someone else.
- **React off-turn.** It only wakes on its own turns, so interrupts, reactions and Attacks of
  Opportunity have to come from the GM.
- **Read enemy sheets.** It sees other combatants' name, types, HP %, combat stages, conditions
  and position, not their moves or stats. If it should "know" something about the party, write it
  in the brief.
- **Remember earlier fights.** Anything that matters goes in the brief.

**Rules for writing the brief**
- **Use exact names.** Use the **exact token/actor names** as they appear in Foundry (e.g.
  `Yacuma`) in **Who → Pilots**, and when naming targets.
- **Give priorities and thresholds, not prose.** "Target the lowest-HP% enemy within 6 m" beats
  "fight cleverly". Give HP-percent triggers (it sees exact HP only for its own side).
- **Only list moves that exist.** List the moves, features and items the piloted actor actually
  has (I'll paste them below). Say which to prefer and when. Don't invent moves.
- **Mark rule sources.** Mark any rule as **PTR** (wiki or source) or **CORE**, and state house
  rules explicitly.
- **Voice lines:** short, one per turn at most, with a few to choose from per situation.
- **Out of scope:** anything it can't do goes there, with what to do instead ("skip", "end turn",
  "say X").

**Encounter material** (filled in below):
- Piloted actor(s): name, species/class, level, types, moves (with range, frequency, AC, DB),
  abilities, features, held items.
- Opponents: who they are, and what the pilot should be allowed to know about them.
- Map: size, notable terrain, starting positions if fixed.
- Goal of the encounter: win, delay, test the party, a scripted retreat…
- Anything that must or must not happen (plot or safety rails).

[paste `_template.md` here]

[paste the encounter material here]
