/**
 * Read `claude-plugins/fabrika/hooks.json` and judge it against the two rules that fix the surface.
 *
 * This exists so the declaration is checked as *data* rather than by a reviewer's eye. The rules are
 * not restated here — they are cli-interface-convention rule 5 (a plain literal command string, and
 * the literal is `fabrika`) and rule 6 (fabrika calls nothing outside fabrika, ADR 0238). What this
 * module adds is the machine-checkable form of each.
 *
 * {@link declaredHooks} is also what binds the surface's test to the surface itself: the golden test
 * runs the argv it reads *out of the committed declaration*, so a test that passes can never be
 * exercising a verb the declaration does not name.
 */

/** One declared hook, flattened out of the event → matcher-group → hooks nesting. */
export interface DeclaredHook {
	readonly event: string;
	readonly matcher: string | undefined;
	readonly command: string;
}

/** A declared command and the rule it breaks. An empty array is the conforming state. */
export interface Violation {
	readonly command: string;
	readonly reason: string;
}

/** Exactly `fabrika <group> <verb>`, single-spaced, lowercase-kebab tokens, and nothing else. */
export const LITERAL_COMMAND = /^fabrika [a-z][a-z-]*(?: [a-z][a-z-]*)+$/;

/**
 * Shell metacharacters a fabrika hook command may never carry.
 *
 * The list is the harness isolation verifier's concern restated as a check: a command string that
 * expands, substitutes or chains is not a literal, whatever it evaluates to.
 */
const SHELL_CONSTRUCTS: ReadonlyArray<readonly [RegExp, string]> = [
	[/\$/, "carries a $ expansion"],
	[/`/, "carries a backtick substitution"],
	[/[;&|]/, "chains or pipes another command"],
	[/(^|\s)(source|\.)\s/, "sources a file"],
	[/[<>]/, "redirects a stream"],
];

/**
 * Rule 6's reach, as strings a fabrika hook command may never name.
 *
 * The v1 verb package was the list's other member until its tree was deleted (#6100); the plugin
 * name stays because `claude-plugins/kampus-pipeline/` is still on disk and still nameable.
 */
const OUTSIDE_FABRIKA: ReadonlyArray<string> = ["kampus-pipeline"];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/**
 * Flatten a parsed `hooks.json` into one row per declared command.
 *
 * Tolerant of shape by design: anything that is not a well-formed hook entry contributes no row, so
 * a malformed document reads as **zero hooks** — which every caller must treat as a failure rather
 * than as a pass (ADR 0092). The callers here do; this function does not decide it.
 */
export const declaredHooks = (document: unknown): ReadonlyArray<DeclaredHook> => {
	const root = asRecord(document);
	const events = root === undefined ? undefined : asRecord(root.hooks);
	if (events === undefined) return [];

	const rows: DeclaredHook[] = [];
	for (const [event, groups] of Object.entries(events)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			const entry = asRecord(group);
			if (entry === undefined || !Array.isArray(entry.hooks)) continue;
			const matcher = typeof entry.matcher === "string" ? entry.matcher : undefined;
			for (const hook of entry.hooks) {
				const declared = asRecord(hook);
				if (declared === undefined || typeof declared.command !== "string") continue;
				rows.push({event, matcher, command: declared.command});
			}
		}
	}
	return rows;
};

/** Every way the declared commands break rule 5 or rule 6. Empty is the conforming state. */
export const violations = (hooks: ReadonlyArray<DeclaredHook>): ReadonlyArray<Violation> => {
	const found: Violation[] = [];
	for (const {command} of hooks) {
		for (const [pattern, reason] of SHELL_CONSTRUCTS) {
			if (pattern.test(command)) found.push({command, reason: `rule 5: ${reason}`});
		}
		if (!LITERAL_COMMAND.test(command)) {
			found.push({command, reason: "rule 5: not a plain literal `fabrika <group> <verb>` string"});
		}
		for (const foreign of OUTSIDE_FABRIKA) {
			if (command.includes(foreign)) {
				found.push({command, reason: `rule 6: names ${foreign}, which is outside fabrika`});
			}
		}
	}
	return found;
};

/** The argv a declared command runs as — `fabrika` dropped, since the test drives the bin directly. */
export const argvOf = (command: string): ReadonlyArray<string> => command.split(" ").slice(1);
