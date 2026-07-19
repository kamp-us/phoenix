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
 * The machine-local-path shapes themselves — the generic deny-list design, the
 * `~/.claude` config-file carve-out (#3475/#3505), and the `/tmp/…-*.sock` glob
 * carve-out (#3492) — live in the single shared `path-matcher.ts` module that both
 * this doc/comment scanner and `crew-leak.ts` import, so the two detectors can never
 * drift (the #3506 root bug). This module owns only the doc-surface scoping (which
 * files get scanned) and the self-exempt list; the path shapes are imported, not
 * re-declared. See `path-matcher.ts` for the pattern rationale.
 */
import {MACHINE_LOCAL_PATH_PATTERNS, type PathPattern, TEMP_PATH_PATTERNS} from "./path-matcher.ts";

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
	// The shared machine-local-path matcher spells the forbidden token shapes out as
	// patterns (moved out of leak-guard.ts per #3506), so it is exempt like its host was.
	"/packages/pipeline-cli/src/tools/leak-guard/path-matcher.ts",
	"/packages/pipeline-cli/src/tools/leak-guard/path-matcher.unit.test.ts",
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

const normalize = (path: string): string => path.replace(/\\/g, "/");

/** Every leak in `text` for `patterns`, deduped on matched+reason (report order = pattern order). */
const scanPatterns = (text: string, patterns: ReadonlyArray<PathPattern>): ReadonlyArray<Leak> => {
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
	return scanPatterns(text, MACHINE_LOCAL_PATH_PATTERNS);
};

/**
 * Every machine-local path leak in a PR/issue COMMENT body — the surface `findLeaks` never
 * reaches (it scopes to doc *files*), the gap that let a `review-*` verdict comment carry a
 * `/private/tmp/.../scratchpad/verdict.md` scratchpad ref and a `@/var/folders/.../tmp.XXXX`
 * mktemp path onto public PRs (#2796/#2822/#2683/#2772). A comment body is UNCONDITIONALLY a
 * shared public artifact, so there is no doc-surface gate and no self-exempt list — it scans
 * the shared `MACHINE_LOCAL_PATH_PATTERNS` AND the stricter comment-body-only `TEMP_PATH_PATTERNS`
 * (which carries the `/tmp/…-*.sock` glob carve-out, #3492). Generic path shapes only (#2393).
 */
export const findCommentLeaks = (text: string): ReadonlyArray<Leak> => {
	if (!text) return [];
	return scanPatterns(text, [...MACHINE_LOCAL_PATH_PATTERNS, ...TEMP_PATH_PATTERNS]);
};
