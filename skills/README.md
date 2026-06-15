# skills/ — the agent-operable issue pipeline

This directory is the **canonical home** for phoenix's skill suite: the GitHub
issue-intake pipeline (`report` → `triage` → `plan-epic` → `review-plan` →
`write-code` → `review-code` / `review-doc` → `ship-it`, plus `heal-ci`, `adr`,
`deslop-comments`) and the shared contract doc `gh-issue-intake-formats.md`.

## Layout: one canonical home, bridged by a clone-safe symlink

Claude Code's **plugin** discovery scans only a plugin-root `skills/` directory and
offers no manifest field to redirect it. Phoenix's **local** discovery reads
`.claude/skills/`. To satisfy both with **no duplicated content**:

- **Canonical files live here, at repo-root `skills/`** — the plugin-root location.
- **`.claude/skills` is a symlink → `../skills`** (relative target, stored in git as a
  mode-`120000` symlink blob). Local discovery follows it to this directory.

Editing a file in one location is editing it in the other — there is exactly one source
of truth. The relative symlink target (`../skills`) means it **resolves in a fresh
`git clone`** (marketplace installs clone the repo), not only in the working tree.

```
phoenix/
├── skills/                 # canonical — plugin-root discovery location
│   ├── <name>/SKILL.md
│   └── gh-issue-intake-formats.md
└── .claude/
    └── skills -> ../skills # symlink — local .claude/skills/ discovery
```

### Link invariants

- **Intra-suite links stay relative and travel inside `skills/`**: each `SKILL.md`'s
  `../gh-issue-intake-formats.md` and `../<sibling>/SKILL.md` resolve against this tree
  regardless of which discovery path reached them.
- **External doc-references** (`../../../.decisions/*`, `.patterns/*`, `CLAUDE.md`) are
  phoenix-specific rationale and are rewritten to stable GitHub URLs separately (see ADR
  0062 §4); they are not bundled into an adopter's repo.

## In-repo discovery doubling — accept the doubles (ADR 0062 §5)

When the plugin is installed at **user scope** and a maintainer works **inside phoenix**,
every skill surfaces twice in the picker: bare `report` (project-scope `.claude/skills/`)
and `phoenix:report` (plugin scope). Claude Code does not dedupe skill names across scopes
and has no per-project plugin disable (upstream anthropics/claude-code#53923).

**Disposition: accept the doubles for v1.** The recommendation is that **phoenix
maintainers rely on the local `.claude/skills/` discovery and do _not_ install the plugin
into phoenix itself** — they already have the canonical suite locally; the plugin exists
for *other* repos. This is a documentation cost, not a functional one. Revisit if/when
upstream ships a per-project plugin toggle. See ADR 0062 §5 for the full rationale.
