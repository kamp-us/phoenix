/**
 * `crew-leak` core — the pure, IO-free matcher for the pipeline-crew sanitization
 * contract (issue #2357, crew epic #2342 Phase 4). Where `findLeaks` (leak-guard.ts)
 * scopes to *doc surfaces* and only the no-local-paths rule, this scans EVERY file
 * shipped under `claude-plugins/pipeline-crew/` for every personal-data class the
 * crew's "zero real operator data" contract bans (PERSONALIZATION.md): machine-local
 * paths, emails, tmux pane ids, real operator names, and personal-memory references.
 *
 * Two design decisions carry the false-positive safety, both grounded in the shipped
 * crew content (README.md, PERSONALIZATION.md, crew.config.template.jsonc):
 *
 *  - Real-operator data is a NAMED DENY-LIST, not a generic detector. The README
 *    documents the seam with *fictional* examples on purpose — `@robin`,
 *    `"Robin Operator"`, `"Sam Approver"`, `#crew-pings`. A generic name/@handle
 *    matcher would red-flag that legitimate documentation. So the "operator-name"
 *    class matches only the KNOWN real phoenix operators; fictional stand-in values
 *    pass, real ones don't — which is exactly what the contract bans.
 *  - The path class mirrors leak-guard's precise deny-list (the specific machine-local
 *    home dirs), not a bare-`~/` catch-all, extended with `/home/<name>`. The crew
 *    ships `${CLAUDE_PLUGIN_ROOT}` and relative `../../.decisions/...` paths, which
 *    are not machine-local and must pass.
 *
 * Every match class is unit-tested in `crew-leak.unit.test.ts`; the deny-list is the
 * load-bearing safety, so it lives in one place and is exercised class by class.
 */

export type LeakClass = "path" | "email" | "tmux-id" | "operator-name" | "memory-ref";

export interface CrewLeak {
	/** Which sanitization-contract class this hit belongs to. */
	readonly class: LeakClass;
	/** The exact substring that matched. */
	readonly matched: string;
	/** Human-readable report line for this hit. */
	readonly reason: string;
}

interface ClassPattern {
	readonly class: LeakClass;
	readonly pattern: RegExp;
	readonly reason: string;
}

/**
 * The real phoenix operators the crew must never hardcode — the deny-list the
 * "operator-name" class is grounded in. These are the actual people the original
 * author's install addressed; the shipped plugin parameterizes them behind the
 * `operator.*` / `controlPlaneApprover.*` seam keys, so any literal occurrence in
 * crew content is a sanitization miss. Fictional README examples (robin/sam) are
 * deliberately absent from this list, so they pass.
 */
export const OPERATOR_NAMES: ReadonlyArray<string> = [
	"umut",
	"sirin",
	"usirin",
	"cansirin",
	"imperialwarrior",
];

const operatorNamePattern = new RegExp(`\\b(?:${OPERATOR_NAMES.join("|")})\\b`, "gi");

// Order = report order. Every pattern carries the global flag for the per-match scan.
const CLASS_PATTERNS: ReadonlyArray<ClassPattern> = [
	{
		class: "path",
		pattern: /\/Users\/[A-Za-z0-9._-]+/g,
		reason: "absolute macOS home path (/Users/<name>/...)",
	},
	{
		class: "path",
		pattern: /\/home\/[A-Za-z0-9._-]+/g,
		reason: "absolute Linux home path (/home/<name>/...)",
	},
	{
		class: "path",
		pattern: /(?<![\w.])~\/\.(?:claude|usirin|agent)\b/g,
		reason: "agent/tool home dir (~/.claude, ~/.usirin, ~/.agent)",
	},
	{
		class: "path",
		pattern: /(?<![\w.])~\/code\//g,
		reason: "home-dir sibling-repo clone (~/code/...)",
	},
	{
		class: "path",
		pattern: /(?<![\w/])\/vault\//g,
		reason: "vault path (/vault/...)",
	},
	{
		class: "email",
		pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
		reason:
			"email address (a notification handle is operator data — use the notification.* seam key)",
	},
	{
		// tmux pane id (`%11`), the concrete shape the crew's tmux topology is
		// parameterized behind (`tmux.windows.*`). Hex url-encoding (`%2F`) carries a
		// letter and doesn't match; a bare `%` (printf, format) has no trailing digits.
		class: "tmux-id",
		pattern: /(?<![%\w])%\d{1,3}\b/g,
		reason: "tmux pane id (%N) — address roles via the tmux.* seam key, not a literal pane",
	},
	{
		class: "memory-ref",
		pattern: /\bMEMORY\.md\b/g,
		reason: "personal auto-memory file (MEMORY.md)",
	},
	{
		class: "memory-ref",
		pattern: /\/memory\//g,
		reason: "personal-memory directory (/memory/...)",
	},
	{
		// The auto-memory slug filenames (`feedback_credential_share_then_rotate`,
		// `reference_ea_ping_sound_sosumi`, `project_phoenix_state`) — prefix + at
		// least two underscore-joined segments, distinctive enough not to catch an
		// ordinary `reference_x` identifier.
		class: "memory-ref",
		pattern: /\b(?:feedback|reference|project)_[a-z0-9]+(?:_[a-z0-9]+)+\b/g,
		reason: "personal auto-memory slug (feedback_*/reference_*/project_*)",
	},
	{
		class: "operator-name",
		pattern: operatorNamePattern,
		reason:
			"real operator name — the crew parameterizes people behind the operator.* / controlPlaneApprover.* seam keys",
	},
];

/** Every personal-data leak in `text`, deduped on class+matched, in report order. */
export const findCrewLeaks = (text: string): ReadonlyArray<CrewLeak> => {
	if (!text) return [];
	const seen = new Set<string>();
	const leaks: Array<CrewLeak> = [];
	for (const {class: cls, pattern, reason} of CLASS_PATTERNS) {
		for (const match of text.matchAll(pattern)) {
			const matched = match[0];
			const key = `${cls}\t${matched}`;
			if (seen.has(key)) continue;
			seen.add(key);
			leaks.push({class: cls, matched, reason});
		}
	}
	return leaks;
};
