/**
 * `crew-leak` core — the pure, IO-free, GENERIC-PATTERN personal-data detector for the
 * pipeline-crew sanitization contract (issue #2357, crew epic #2342 Phase 4). Where
 * `findLeaks` (leak-guard.ts) scopes to *doc surfaces* and only the no-local-paths rule,
 * this scans EVERY file shipped under `claude-plugins/pipeline-crew/` for the high-value
 * personal-data classes the crew's "zero real operator data" contract bans, each detected
 * by its STRUCTURAL shape — never by a hardcoded person identifier:
 *
 *  - machine-local / home / absolute paths (`/Users/<name>`, `/home/<name>`, `~/.claude`, …),
 *  - email addresses (any `local@domain.tld` — a crew def should carry ZERO emails),
 *  - tmux pane ids (`%N`),
 *  - personal auto-memory references (`MEMORY.md`, `/memory/`, `feedback_*`/`reference_*` slugs).
 *
 * Deliberately scope-limited (founder ruling): the check carries NO named operator
 * deny-list and NO personal identifiers (names or emails) — not in this module and not in
 * its tests. A bare first name in prose is therefore NOT caught, and that is accepted: the
 * high-value leaks (emails, local/home paths, creds) are all pattern-detectable, whereas
 * bare-name matching is low-value and false-positive-prone (it would red-flag the README's
 * fictional `Robin`/`Sam` seam examples), so it is intentionally dropped. Do not add
 * name-literal matching back in any form.
 *
 * The `"path"` class is the SHARED `MACHINE_LOCAL_PATH_PATTERNS` from `path-matcher.ts`
 * (the single source both detectors import, per the #3506 ruling) — so its config-file and
 * `/tmp` shape carve-outs can never drift from leak-guard's, which was the root bug #3506
 * records. Layered on top of the shared arm are the crew-only classes this sanitizer adds:
 * an absolute Linux `/home/<name>` path (stricter than leak-guard's macOS-only home arm),
 * plus emails, tmux pane ids, and personal auto-memory refs. `${CLAUDE_PLUGIN_ROOT}` and
 * relative `../../.decisions/...` paths are not machine-local and must pass. Every class is
 * unit-tested in `crew-leak.unit.test.ts`, class by class, on FICTIONAL fixtures.
 */
import {MACHINE_LOCAL_PATH_PATTERNS} from "./path-matcher.ts";

export type LeakClass = "path" | "email" | "tmux-id" | "memory-ref";

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

// Order = report order. Every pattern carries the global flag for the per-match scan.
// The `"path"` class is the shared `MACHINE_LOCAL_PATH_PATTERNS` tagged with the class, then the
// crew-only Linux `/home/<name>` arm and the three non-path classes layered on top (see docblock).
const CLASS_PATTERNS: ReadonlyArray<ClassPattern> = [
	...MACHINE_LOCAL_PATH_PATTERNS.map(
		(p): ClassPattern => ({class: "path", pattern: p.pattern, reason: p.reason}),
	),
	{
		class: "path",
		pattern: /\/home\/[A-Za-z0-9._-]+/g,
		reason: "absolute Linux home path (/home/<name>/...)",
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
