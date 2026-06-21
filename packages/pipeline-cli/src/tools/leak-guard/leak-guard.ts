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
	"/skills/review-doc/SKILL.md",
	"/skills/triage/SKILL.md",
	"/skills/report/SKILL.md",
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
		pattern: /\/Users\/[A-Za-z0-9._-]+/g,
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

const normalize = (path: string): string => path.replace(/\\/g, "/");

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

	const seen = new Set<string>();
	const leaks: Leak[] = [];
	for (const {pattern, reason} of LEAK_PATTERNS) {
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
