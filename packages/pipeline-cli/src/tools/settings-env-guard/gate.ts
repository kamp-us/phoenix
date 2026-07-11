/**
 * The `settings-env-guard` filesystem gate — the IO seam behind #2495's "no
 * `.claude/settings.json` env value carries an unexpanded `${...}`" check, split
 * from `command.ts` so it is crossable in unit tests over a fake settings file
 * rather than only by spawning the bin (the core-in-its-own-file idiom; #855).
 *
 * `checkSettingsEnv` reads `<root>/.claude/settings.json`, JSON-parses it, reduces
 * its `env` object to string-valued entries, and delegates the verdict to the pure
 * core (`settings-env-guard.ts`). It fails `CheckFailed` (exit non-zero) when any
 * env value carries a `${...}`; a missing/unreadable/unparseable settings.json is
 * an `IoError` (also non-zero) — fail-closed on the file we can't scan (ADR 0092).
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Data, Effect} from "effect";
import {type EnvEntry, judge, renderReport} from "./settings-env-guard.ts";

/** A read/parse failure: the guard couldn't scan the settings file — fail-closed (ADR 0092). */
export class IoError extends Data.TaggedError("IoError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Data.TaggedError("CheckFailed")<{readonly reason: string}> {}

const SETTINGS_PATH = ".claude/settings.json";

/** Reduce a parsed settings object's `env` block to string-valued entries (the core's input). */
const envEntries = (settings: unknown): ReadonlyArray<EnvEntry> => {
	if (typeof settings !== "object" || settings === null) return [];
	const env = (settings as {env?: unknown}).env;
	if (typeof env !== "object" || env === null) return [];
	return Object.entries(env as Record<string, unknown>).flatMap(([key, value]) =>
		typeof value === "string" ? [{key, value}] : [],
	);
};

/** Read + JSON-parse `<root>/.claude/settings.json`; an IO/parse failure is fail-closed. */
const readSettings = (root: string): Effect.Effect<unknown, IoError> =>
	Effect.try({
		try: () => JSON.parse(readFileSync(join(root, SETTINGS_PATH), "utf8")) as unknown,
		catch: (cause) => new IoError({path: join(root, SETTINGS_PATH), cause}),
	});

/**
 * The CI gate: succeed when no `.claude/settings.json` env value carries an
 * unexpanded `${...}`, else `CheckFailed`. Fails closed (`IoError`) on a
 * missing/unreadable/unparseable settings file (ADR 0092).
 */
export const checkSettingsEnv = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const settings = yield* readSettings(root);
		const verdict = judge(envEntries(settings));
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
