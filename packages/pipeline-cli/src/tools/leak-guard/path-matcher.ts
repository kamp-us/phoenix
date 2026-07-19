/**
 * The single machine-local-path matcher shared by BOTH leak-guard detectors — the doc/comment
 * scanner (`leak-guard.ts`) and the crew-plugin sanitizer (`crew-leak.ts`). Extracted per the
 * founder ruling on #3506 (Option C — extract, don't copy): the two detectors each carried their
 * own copy of the same path arm, and #3505's `~/.claude` shape carve-out landed on leak-guard's
 * copy only — so the copies drifted, which is the exact root bug #3506 records. With the arm (and
 * every path-shape carve-out) living HERE once, the two-detectors-drift class of bug is structurally
 * impossible rather than fixed one instance at a time.
 *
 * Two arms, both GENERIC structural shapes and never a named operator allow-list (#2393):
 *
 *  - `MACHINE_LOCAL_PATH_PATTERNS` — the home/absolute path arm (`/Users/<name>`, `~/.usirin`,
 *    `~/.claude` internals, `~/code/`, `/vault/`). Used by every leak-guard surface and by
 *    crew-leak's `"path"` class.
 *  - `TEMP_PATH_PATTERNS` — the stricter temp/scratch roots (`/var/folders/…`, `/private/tmp|var/…`,
 *    `/tmp/…`). leak-guard scans these on the PR/issue-COMMENT surface only (a public comment has no
 *    legitimate bare-`/tmp` example the way a doc does); crew-leak does not scan temp roots.
 *
 * Carve-outs live at the pattern (a property of the shape), not in a membership list:
 *  - `~/.claude.json` and `~/.claude/settings.json` — the two public, machine-agnostic claude CLI
 *    config *files* — pass, while any `~/.claude/`-directory descent still flags (#3475/#3505).
 *  - a username-free, `*`-globbed `/tmp/…-*.sock` (e.g. `/tmp/kampus-crew-inbox-*.sock`) passes: it
 *    is a well-known socket's glob NAME, not a machine-local instance, the same public-token class as
 *    the config-file carve-out above (#3492 founder ruling — Option A). A concrete `/tmp/<name>/…`
 *    scratch path (no glob) still flags — the exemption REQUIRES the `*`, so nothing machine-local
 *    is let through.
 */

export interface PathPattern {
	readonly pattern: RegExp;
	readonly reason: string;
}

// Order = report order. Each `g` flag is required for the per-match `matchAll` scan the consumers run.
export const MACHINE_LOCAL_PATH_PATTERNS: ReadonlyArray<PathPattern> = [
	{
		// The `(?<![A-Za-z]:)` drive-letter carve-out keeps this a GENERIC structural check
		// while dropping the Windows-file-URL false positive: a bare POSIX `/Users/<name>/`
		// still matches (real macOS-home leak), but a drive-prefixed `C:/Users/...` (e.g.
		// `file:///C:/Users/ci/...`) does not — that substring is not a macOS home path and
		// carries no operator PII, yet its FP fail-closed-blocked legitimate PRs (#3070).
		pattern: /(?<![A-Za-z]:)\/Users\/[A-Za-z0-9._-]+/g,
		reason: "absolute macOS home path (/Users/<name>/...)",
	},
	{
		pattern: /(?<![\w.])~\/\.(usirin|agent)\b/g,
		reason: "agent/tool home dir (~/.usirin, ~/.agent)",
	},
	{
		// The `~/.claude` home-dir detector, NARROWED by shape (not a named allow-list; #2393
		// and #3475): it still flags any descent into the private agent home tree
		// (`~/.claude/projects/…`, `~/.claude/todos/…`) and bare `~/.claude`, but the two
		// negative lookaheads carve out the claude CLI's public, machine-agnostic config *files*
		// — `~/.claude.json` (a sibling dotfile config, `~/.claude` + a `.json` extension, NOT
		// the directory) and `~/.claude/settings.json` (the one documented settings file). Those
		// two are identical on every machine and reveal nothing operator-specific, and they are
		// the literal subject of packages/pipeline-crew-mcp, so flagging them was a chronic
		// false positive. The carve-out is SHAPE, not a membership list: the exclusion is a
		// property of this one generic pattern (a config-file leaf on the marker), so a longer
		// name (`~/.claude.json.bak`, `~/.claude/settings.local.json`, `~/.claude/settings.jsonc`)
		// or any deeper path still trips it — the `(?![\w.])` tail pins each carve-out to the
		// exact public leaf. See the threat-model note on #3475 for what this can no longer catch.
		pattern: /(?<![\w.])~\/\.claude(?!\.json(?![\w.]))(?!\/settings\.json(?![\w.]))\b/g,
		reason:
			"agent/tool home dir (~/.claude internals; public config files ~/.claude.json, ~/.claude/settings.json exempt)",
	},
	{
		pattern: /(?<![\w.])~\/code\//g,
		reason: "home-dir sibling-repo clone (~/code/...)",
	},
	{
		pattern: /(?<![\w/])\/vault\//g,
		reason: "vault path (/vault/...)",
	},
];

// Machine-local temp/scratch roots — a PR/issue COMMENT (or verdict) body must never carry one
// (the #2796/#2822 scratchpad-`@filepath` and #2683/#2772 mktemp-in-`@sha` leaks). Generic path
// shapes, NOT a named deny-list (#2393). The `(?<![\w.])` lookbehind stops a `/private/tmp/...`
// match from also double-firing the `/tmp/` pattern (its preceding char is a word char), so each
// leak reports once.
export const TEMP_PATH_PATTERNS: ReadonlyArray<PathPattern> = [
	{
		pattern: /(?<![\w.])\/var\/folders\/[A-Za-z0-9._/-]+/g,
		reason: "macOS per-user mktemp dir (/var/folders/...)",
	},
	{
		pattern: /(?<![\w.])\/private\/(?:tmp|var)\/[A-Za-z0-9._/-]+/g,
		reason: "macOS resolved temp root (/private/tmp/..., /private/var/...)",
	},
	{
		// The `/tmp/` scratch detector, NARROWED by shape (#3492 founder ruling — Option A, the
		// same by-shape idiom as the `~/.claude` config-file carve-out above, never a named token
		// list; #2393). The negative lookahead exempts a username-free, `*`-globbed socket NAME —
		// `/tmp/kampus-crew-inbox-*.sock` — because a glob is a well-known socket's name, not a
		// machine-local instance, and reviewer verdicts whose SUBJECT is that socket predictably
		// narrate it in prose (which was fail-closed-blocking crew-mcp ships at scan-pr Step 3.7).
		// The exemption REQUIRES the `*` and a single terminal `.sock` leaf with no `/` descent, so
		// a concrete scratch path (`/tmp/<user>-scratch/…`, any `/tmp/<name>/…`) — which has no glob
		// or descends into a dir that could hide a username — still flags. A `.sock` backup
		// (`…-*.sock.bak`) still flags too (the `(?![\w.])` tail pins the exemption to the leaf).
		pattern:
			/(?<![\w.])\/tmp\/(?![A-Za-z0-9._-]*\*[A-Za-z0-9._*-]*\.sock(?![\w.]))[A-Za-z0-9._/-]+/g,
		reason: "machine-local temp/scratch path (/tmp/...)",
	},
];
