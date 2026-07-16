/**
 * `leak-guard` core — the pure, IO-free matcher that decides whether a write puts
 * a user-local filesystem path into a SHARED artifact (issue #173), moved into the
 * pipeline-cli registry (epic #994, Phase 2 / #999).
 *
 * This is the write-time enforcement of the repo's no-local-paths rule that used
 * to live only in per-skill prose (the failure mode that shipped a vault path to
 * main — see #158). `findLeaks(filePath, text)` returns every leak in `text` when
 * `filePath` is a shared-artifact doc surface and not self-exempt; otherwise an
 * empty list. No regex over arbitrary source — the match is scoped to doc surfaces
 * exactly as the AC requires.
 *
 * The non-obvious part is the deny-list design: it matches ONLY the specific #158
 * leak dirs (`/Users/<name>`, `~/.claude|.usirin|.agent`, `~/code/`, `/vault/`),
 * NOT a general bare-`~/` catch-all. So any other `~/<x>` — `~/.config`,
 * `~/.alchemy` (a documented tool dir; see .patterns/alchemy-ci-cd.md),
 * `~/Documents` — PASSES, because it leaks no identity of this machine. Plus the
 * `/tmp` scratch carve-out and the path-hygiene self-exempt files. That precise
 * allowlist is the load-bearing false-positive safety, encoded in
 * `leak-guard.unit.test.ts`.
 */

export interface Leak {
	/** The exact substring that matched a leak pattern. */
	readonly matched: string;
	/** Human-readable reason, the report line for this leak class. */
	readonly reason: string;
}

const DOC_SUFFIXES = [".md", ".mdx", ".markdown"] as const;
const DOC_DIRS = ["/.decisions/", "/.patterns/"] as const;

// Files whose subject IS path hygiene: they must spell the forbidden tokens out as
// patterns, so they are exempt by path suffix. Includes the leak-guard's own source
// (the old package AND this moved tool) and the skills that name the patterns.
const DOC_SELF_EXEMPT = [
	"/packages/leak-guard/src/leak-guard.ts",
	"/packages/leak-guard/src/leak-guard.unit.test.ts",
	"/packages/leak-guard/src/bin.ts",
	"/packages/leak-guard/README.md",
	"/packages/pipeline-cli/src/tools/leak-guard/leak-guard.ts",
	"/packages/pipeline-cli/src/tools/leak-guard/leak-guard.unit.test.ts",
	"/packages/pipeline-cli/src/tools/leak-guard/command.ts",
	// Documents the leak-guard deny-list patterns (the ~/.claude / ~/code/ / /vault
	// example shapes), so it must spell the forbidden tokens out — exempt like the
	// old package's own README already is.
	"/packages/pipeline-cli/README.md",
	"/skills/review-doc/SKILL.md",
	"/skills/triage/SKILL.md",
	"/skills/report/SKILL.md",
	// The triager agent's ## Output privacy rule names ~/code/... / /Users/... as the
	// machine-local shapes it forbids in the return summary (#1956) — illustrative rule
	// text, not real paths, so routine edits must not trip the guard.
	"/agents/triager.md",
	"/skills/report/footer.sh",
	// Its Lineage section deliberately names ~/code/... sibling-repo clones (the
	// rebuild provenance), so routine edits to it must not trip the guard.
	"/CLAUDE.md",
] as const;

interface LeakPattern {
	readonly pattern: RegExp;
	readonly reason: string;
}

// Order = report order. Each `g` flag is required for the per-match scan in findLeaks.
const LEAK_PATTERNS: ReadonlyArray<LeakPattern> = [
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
		pattern: /(?<![\w.])~\/\.(claude|usirin|agent)\b/g,
		reason: "agent/tool home dir (~/.claude, ~/.usirin, ~/.agent)",
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

// Machine-local temp/scratch roots — a PR/issue COMMENT (or verdict) body must never carry
// one (the #2796/#2822 scratchpad-`@filepath` and #2683/#2772 mktemp-in-`@sha` leaks). This is
// deliberately STRICTER than the doc-surface `findLeaks`, which carves out a bare `/tmp` for
// illustrative examples in docs — a public PR comment has no such legitimate use, so these are
// scanned by `findCommentLeaks` only, never by the file-surface path. Generic path shapes, NOT
// a named deny-list (#2393): the macOS mktemp dirs and a bare `/tmp` scratch path. The
// `(?<![\w.])` lookbehind stops a `/private/tmp/...` match from also double-firing the `/tmp/`
// pattern (its preceding char is a word char), so each leak reports once.
const TEMP_PATTERNS: ReadonlyArray<LeakPattern> = [
	{
		pattern: /(?<![\w.])\/var\/folders\/[A-Za-z0-9._/-]+/g,
		reason: "macOS per-user mktemp dir (/var/folders/...)",
	},
	{
		pattern: /(?<![\w.])\/private\/(?:tmp|var)\/[A-Za-z0-9._/-]+/g,
		reason: "macOS resolved temp root (/private/tmp/..., /private/var/...)",
	},
	{
		pattern: /(?<![\w.])\/tmp\/[A-Za-z0-9._/-]+/g,
		reason: "machine-local temp/scratch path (/tmp/...)",
	},
];

const normalize = (path: string): string => path.replace(/\\/g, "/");

/** Every leak in `text` for `patterns`, deduped on matched+reason (report order = pattern order). */
const scanPatterns = (text: string, patterns: ReadonlyArray<LeakPattern>): ReadonlyArray<Leak> => {
	const seen = new Set<string>();
	const leaks: Leak[] = [];
	for (const {pattern, reason} of patterns) {
		for (const match of text.matchAll(pattern)) {
			const matched = match[0];
			const key = `${matched}\t${reason}`;
			if (seen.has(key)) continue;
			seen.add(key);
			leaks.push({matched, reason});
		}
	}
	return leaks;
};

export const isSharedArtifact = (path: string): boolean => {
	const p = normalize(path);
	if (DOC_SUFFIXES.some((s) => p.endsWith(s))) return true;
	// Leading-slash the path so a relative `.decisions/x` matches the same `/.decisions/`
	// token as an absolute one (Write passes absolute; be robust to relative targets).
	const rooted = `/${p.replace(/^\/+/, "")}`;
	return DOC_DIRS.some((d) => rooted.includes(d));
};

export const isSelfExempt = (path: string): boolean => {
	// Normalize to a leading slash so a relative `.claude/...` target matches the same
	// suffix as an absolute `/…/.claude/...` one (Write passes absolute, but be robust).
	const p = `/${normalize(path).replace(/^\/+/, "")}`;
	return DOC_SELF_EXEMPT.some((s) => p.endsWith(s));
};

/** Every leak in `text` (deduped on matched+reason), scoped to the file surface. */
export const findLeaks = (filePath: string, text: string): ReadonlyArray<Leak> => {
	if (!filePath || !text) return [];
	if (!isSharedArtifact(filePath)) return [];
	if (isSelfExempt(filePath)) return [];
	return scanPatterns(text, LEAK_PATTERNS);
};

/**
 * Every machine-local path leak in a PR/issue COMMENT body — the surface `findLeaks` never
 * reaches (it scopes to doc *files*), the gap that let a `review-*` verdict comment carry a
 * `/private/tmp/.../scratchpad/verdict.md` scratchpad ref and a `@/var/folders/.../tmp.XXXX`
 * mktemp path onto public PRs (#2796/#2822/#2683/#2772). A comment body is UNCONDITIONALLY a
 * shared public artifact, so there is no doc-surface gate and no self-exempt list — it scans
 * the home-dir `LEAK_PATTERNS` AND the stricter `TEMP_PATTERNS`. Generic path shapes only (#2393).
 */
export const findCommentLeaks = (text: string): ReadonlyArray<Leak> => {
	if (!text) return [];
	return scanPatterns(text, [...LEAK_PATTERNS, ...TEMP_PATTERNS]);
};
