/**
 * `settings-env-guard`'s pure half — does any `.claude/settings.json` `env` VALUE carry an
 * unexpanded `${...}` token (#2495)?
 *
 * The invariant, grounded once: Claude Code applies settings.json `env` values VERBATIM — it does
 * NOT expand `${VAR}` in them (the settings docs describe `env` as "environment variables applied
 * to every session" and document no interpolation; verified on both the desktop and the web
 * harness). So a `${...}` in an env value never resolves: it is consumed literally, which is how
 * `${CLAUDE_PROJECT_DIR}` became a stray directory at the repo root and clobbered PATH. A
 * checkout- or session-relative path an env value wants is resolved in the consuming hook, from
 * the hook-exported `$CLAUDE_PROJECT_DIR`, never wired as an env-value expansion.
 *
 * An empty `env` block is a legitimate pass, not a vacuous one: the scan covered the whole block
 * and found nothing to expand. The fail-closed case is the FILE — a settings.json that is absent or
 * does not parse — and it lives at the IO boundary in `./settings-env-verb.ts`, not here.
 */

/** One `env` entry, reduced to the two facts the decision needs. */
export interface EnvEntry {
	readonly key: string;
	readonly value: string;
}

/** An unexpanded shell-style expansion token — `${CLAUDE_PROJECT_DIR}`, `${PATH}`. */
const EXPANSION = /\$\{[^}]*\}/;

/** The entries whose value carries a literal `${...}`. */
export const literalExpansions = (env: ReadonlyArray<EnvEntry>): ReadonlyArray<EnvEntry> =>
	env.filter((entry) => EXPANSION.test(entry.value));

/**
 * A parsed settings object's `env` block as string-valued entries.
 *
 * A non-string value is dropped rather than stringified: `env` values reach the harness as strings,
 * and coercing a number or an object here would invent bytes to scan that nothing ever sets.
 */
export const envEntries = (settings: unknown): ReadonlyArray<EnvEntry> => {
	if (typeof settings !== "object" || settings === null) return [];
	const env = (settings as {env?: unknown}).env;
	if (typeof env !== "object" || env === null) return [];
	return Object.entries(env as Record<string, unknown>).flatMap(([key, value]) =>
		typeof value === "string" ? [{key, value}] : [],
	);
};

/** The report for the offending entries — one `key = value` line each, then the why and the fix. */
export const expansionReport = (verb: string, offenders: ReadonlyArray<EnvEntry>): string =>
	[
		`${verb}: ${offenders.length} .claude/settings.json env value${offenders.length === 1 ? "" : "s"} carry an unexpanded \${...} token:`,
		...offenders.map((entry) => `  ${entry.key} = ${entry.value}`),
		"",
		"Claude Code applies `env` values VERBATIM — it does NOT expand a brace token in them",
		"(#2495). Such a token never resolves: it is consumed literally, creating a literal-token",
		"directory or clobbering PATH. Resolve a checkout- or session-relative path in the",
		"consuming hook, from the hook-exported $CLAUDE_PROJECT_DIR, never as an env-value",
		"expansion.",
	].join("\n");
