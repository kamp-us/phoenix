/**
 * `settings-env-guard` pure core — decide whether any `.claude/settings.json` `env`
 * VALUE carries an unexpanded `${...}` token (#2495). IO-free and total: a
 * deterministic transform over already-parsed env entries. The filesystem boundary
 * (read + JSON-parse the settings file, extract `env`) lives in `gate.ts`.
 *
 * The invariant this enforces, grounded once: Claude Code applies settings.json
 * `env` VALUES VERBATIM — it does NOT expand `${VAR}` in them (settings docs: `env`
 * = "Environment variables applied to every session"; no interpolation documented,
 * verified on both the desktop and web harnesses). So a `${...}` in an `env` value
 * NEVER resolves — it is consumed literally, which is what created the stray
 * `${CLAUDE_PROJECT_DIR}` directory at the repo root and clobbered PATH (#2495).
 * A checkout- or session-relative path an env value wants must be resolved in the
 * consuming hook (from the hook-exported `$CLAUDE_PROJECT_DIR`), never wired as an
 * env-value expansion. This guard reds fail-closed on the whole class.
 *
 * An empty `env` (or none) is a legitimate PASS, not a vacuous green: the scan
 * covered the entire block and found nothing to expand. The fail-closed-on-missing
 * concern (ADR 0092) is the FILE — an unreadable/unparseable settings.json — and
 * lives at the IO boundary in `gate.ts`, not here.
 */

/** One `env` entry from settings.json, reduced to the two facts the decision needs. */
export interface EnvEntry {
	readonly key: string;
	readonly value: string;
}

/**
 * The guard verdict. A discriminated union so an invalid state is unrepresentable:
 * a pass never carries offenders, and a failure always carries the offending
 * entries (its evidence — ADR 0092 §1 "emit what you scanned").
 */
export type SettingsEnvVerdict =
	| {readonly pass: true; readonly scanned: number}
	| {
			readonly pass: false;
			readonly reason: "literal-expansion";
			readonly offenders: ReadonlyArray<EnvEntry>;
	  };

/** Matches an unexpanded shell-style expansion token, e.g. `${CLAUDE_PROJECT_DIR}` or `${PATH}`. */
const EXPANSION_RE = /\$\{[^}]*\}/;

/** The env entries whose value carries a literal `${...}` — the offenders. */
export const findLiteralExpansions = (env: ReadonlyArray<EnvEntry>): ReadonlyArray<EnvEntry> =>
	env.filter((e) => EXPANSION_RE.test(e.value));

/** Decide the verdict: red on any env value carrying an unexpanded `${...}`, else pass. */
export const judge = (env: ReadonlyArray<EnvEntry>): SettingsEnvVerdict => {
	const offenders = findLiteralExpansions(env);
	if (offenders.length > 0) {
		return {pass: false, reason: "literal-expansion", offenders};
	}
	return {pass: true, scanned: env.length};
};

/** Render the human-readable report for a verdict (ADR 0092 §1 "emit what you scanned"). */
export const renderReport = (verdict: SettingsEnvVerdict): string => {
	if (verdict.pass) {
		return `settings-env-guard: all ${verdict.scanned} .claude/settings.json env value(s) are free of unexpanded \${...} tokens`;
	}
	const lines = verdict.offenders.map((e) => `  ${e.key} = ${e.value}`);
	return (
		`settings-env-guard: ${verdict.offenders.length} .claude/settings.json env value` +
		`${verdict.offenders.length === 1 ? "" : "s"} carry an unexpanded \${...} token:\n${lines.join("\n")}\n\n` +
		"Claude Code applies `env` values VERBATIM — it does NOT expand a brace token\n" +
		"in them (#2495). Such a token in an env value never resolves: it is consumed\n" +
		"literally, creating a literal-token directory or clobbering PATH. Resolve a\n" +
		"checkout- or session-relative path in the consuming hook (from the hook-\n" +
		"exported $CLAUDE_PROJECT_DIR), never as an env-value expansion."
	);
};
