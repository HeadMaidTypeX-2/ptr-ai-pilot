# Battle briefs

The handoff between the design side (e.g. a Claude Chat project with the campaign context) and
the pilot (Claude Code driving `bridge/pilot.mjs`).

1. **Design** the encounter wherever the campaign context lives, then save it here as
   `briefs/<actor-or-encounter>.md`, starting from [`_template.md`](_template.md).
2. **Play.** Before each piloted turn the pilot reads the brief whose **Who → Pilots** list names
   the current actor, and follows its goals, tactics, triggers and voice. With no brief, it plays
   plain sensible tactics and says so in the log.
3. **Debrief.** After the fight the pilot writes `briefs/logs/<date>-<encounter>.md`:
   - a turn-by-turn summary;
   - brief rules it followed or had to break, and why;
   - rules questions and tool gaps it hit.

   Paste it back into the design chat to tune the encounter.

**Briefs and logs stay local.** They are git-ignored (only this README and the template are
tracked), because the repo is public and briefs are boss tactics your players shouldn't read.
OneDrive sync is their backup.
