# @phoenix/leak-guard

The write-time enforcement of the repo's **no-local-paths-in-shared-artifacts**
rule (issue #173). A user-local filesystem path (`/Users/<name>/…`, `~/`,
`~/.claude`, `~/.usirin`, `~/code/…`, `/vault/…`) must never enter a committed
doc surface. That rule used to live only in per-skill prose — a reminder every
agent had to remember, and one didn't (a vault path shipped to `main`; see #158).
This package makes the rule mechanical: a Claude Code **PreToolUse hook** that
blocks the write before it hits disk.

It replaces the earlier Python-hook approach, per the repo's Node-over-Python
convention (mechanical tooling is an Effect CLI package under `packages/`, the
`epic-ledger` / `crabbox-manifest` idiom).

## Shape

- **`src/leak-guard.ts`** — the pure, IO-free core. `findLeaks(filePath, text)`
  returns every leak when `filePath` is a shared-artifact doc surface and not
  self-exempt; an empty list otherwise. This is where the matrix lives.
- **`src/bin.ts`** — the `effect/unstable/cli` command wired on stdin. Reads the
  PreToolUse JSON envelope, extracts `(file_path, text)` for `Write`/`Edit`/
  `MultiEdit`, runs the core, and on a leak emits a
  `hookSpecificOutput.permissionDecision: "deny"` JSON + exits 0. Clean / non-doc
  / unsupported-tool / malformed-envelope → silent allow (exit 0). It **never**
  blocks on a parse failure.
- **`src/leak-guard.unit.test.ts`** — the BLOCK/ALLOW matrix, the load-bearing
  false-positive safety.

## What fires, what doesn't

**Shared-artifact surfaces** (where the guard scans): `*.md` / `*.mdx` /
`*.markdown` anywhere, plus the `.decisions/` and `.patterns/` directories.
Arbitrary source (a `/Users` string literal in a `.ts` fixture) is out of scope.

**Leak patterns** (blocked in a shared artifact):

| pattern | reason |
| --- | --- |
| `/Users/<name>/…` | absolute macOS home path |
| `~/.claude`, `~/.usirin`, `~/.agent` | agent/tool home dir |
| `~/code/…` | home-dir sibling-repo clone |
| `/vault/…` | vault path |
| a leading `~/` (except `~/.config`) | home-relative path |

**Allowlist** (never flagged): repo-relative paths (`apps/web/…`,
`.claude/skills/…`); bare `/tmp/…` scratch (it encodes no user identity);
`~/.config/…` (a documented product path, e.g. the kampus CLI credential store);
`/Users` inside non-doc source; and `DOC_SELF_EXEMPT` path-hygiene files — this
package's own source, the `review-doc` / `triage` / `report` skills, and
`report/footer.sh` — which must spell the forbidden tokens out as patterns.

## Wiring

`.claude/settings.json` registers it as a `Write|Edit|MultiEdit` PreToolUse hook:

```json
{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/packages/leak-guard/src/bin.ts\"" }
```

A PreToolUse hook cannot see `gh issue`/`gh pr` bodies (those are Bash calls, not
Write); the `review-doc` gate + the `report` footer contract remain the net for
posted bodies. This package covers the committed-file half of "shared artifacts",
which is the #158 leak class.

## Commands

```bash
pnpm --filter @phoenix/leak-guard typecheck
pnpm --filter @phoenix/leak-guard test
echo '{"tool_name":"Write","tool_input":{"file_path":"x.md","content":"…"}}' | node packages/leak-guard/src/bin.ts
```
