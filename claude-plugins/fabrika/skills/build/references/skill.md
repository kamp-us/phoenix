# Surface rubric — skill

Agent-facing text under `claude-plugins/*/skills/`: a `SKILL.md`, a rubric or reference file beside
it, a `contract.md`. These files are markdown, so `fabrika build check --surface prose` validates
them; this file is the rubric you read before writing one.

- **Read [`writing-for-agents`](../../writing-for-agents/SKILL.md) and write under it**, before
  authoring or editing any of those files. It carries the levers the text is judged on — where each
  piece sits on the information hierarchy, whether a step's completion criterion is checkable, which
  restatements a leading word retires, and the no-op test every sentence owes. Read it inline as a
  reference; it has no run to spawn. That discipline is the whole route into a skill folder
  (`claude-plugins/fabrika/docs/skill-conventions.md` §8 gate 1), and the gate reads the text rather
  than the session that produced it — so writing some other way and tidying afterwards still lands
  on a refusal.
- **Hold the text to that plugin's conventions doc as well** — for fabrika, the same
  `skill-conventions.md`: a deterministic step belongs in a verb, each fact keeps one home, and a
  contract is read one heading at a time.
- **The placement and sourcing rules in [`prose.md`](prose.md) still bind** — resolvable relative
  links, one home per fact, point rather than restate. Skill text adds discipline on top; it
  replaces none of that. Fabrika's own skill text is read in other repos, so every reference in it
  resolves for a reader who has only the plugin.
