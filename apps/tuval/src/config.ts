/**
 * The user-owned config module and its fail-closed loader.
 *
 * Configuration is code the user owns (the Neovim model, #7484 R1.1): a TypeScript module that
 * default-exports the list of program rows to register at boot. Loading refuses on any defect the
 * loader can see — the module throwing, no default export, a default export that is not a list —
 * and every refusal names the module and the reason, so boot never runs on a half-read config.
 * Hand-ported from the frozen POC's package loading on `epic/7140`
 * (`packages/tuval/src/backend/package-contributions.ts`), which rejected a contribution on the
 * same three seams; the POC itself is never imported.
 *
 * The row type is the registry slice's, not this one's: rows are opaque here.
 */

import {pathToFileURL} from "node:url";
import {Effect, Schema} from "effect";

export type ProgramRows = ReadonlyArray<unknown>;

export class ConfigLoadError extends Schema.TaggedError<ConfigLoadError>()(
	"tuval/ConfigLoadError",
	{
		module: Schema.String,
		reason: Schema.String,
	},
) {
	override get message(): string {
		return `config module ${this.module}: ${this.reason}`;
	}
}

const describe = (value: unknown): string =>
	value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const thrownMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

export const loadConfigModule = Effect.fn("Tuval.loadConfigModule")(function* (modulePath: string) {
	const refuse = (reason: string) => new ConfigLoadError({module: modulePath, reason});
	const loaded = yield* Effect.tryPromise({
		try: (): Promise<Record<string, unknown>> => import(pathToFileURL(modulePath).href),
		catch: (cause) => refuse(`module threw while loading: ${thrownMessage(cause)}`),
	});
	if (!("default" in loaded)) {
		return yield* refuse("no default export; export default the list of program rows");
	}
	const rows = loaded.default;
	if (!Array.isArray(rows)) {
		return yield* refuse(`default export is not a list of program rows (got ${describe(rows)})`);
	}
	return rows as ProgramRows;
});
