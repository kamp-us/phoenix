/**
 * The user-owned config module and its fail-closed loader.
 *
 * Configuration is code the user owns (the Neovim model, #7484 R1.1): a TypeScript module that
 * default-exports the list of program rows to register at boot and, as a named `graph` export,
 * the planned processes and the routes between them. Loading refuses on any defect the loader
 * can see — the module throwing, no default export, a default export that is not a list, a
 * `graph` that is not a graph — and every refusal names the module and the reason, so boot
 * never runs on a half-read config. Hand-ported from the frozen POC's package loading on
 * `epic/7140` (`packages/tuval/src/backend/package-contributions.ts`), which rejected a
 * contribution on the same seams; the POC itself is never imported.
 *
 * The row type is the registry slice's, not this one's: rows are opaque here, and so are the
 * graph's nodes — the ports slice refuses a malformed one when it compiles.
 */

import {pathToFileURL} from "node:url";
import {Effect, Schema} from "effect";
import type {Graph} from "./ports/graph.ts";

export type ProgramRows = ReadonlyArray<unknown>;

export interface LoadedConfig {
	readonly programs: ProgramRows;
	/** `{nodes: []}` when the module exports none: programs registered, no process planned. */
	readonly graph: Graph;
}

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

const isGraph = (value: unknown): value is Graph =>
	typeof value === "object" &&
	value !== null &&
	Array.isArray((value as {readonly nodes?: unknown}).nodes);

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
	if (!("graph" in loaded)) {
		return {programs: rows as ProgramRows, graph: {nodes: []}} satisfies LoadedConfig;
	}
	if (!isGraph(loaded.graph)) {
		return yield* refuse(
			`graph export is not a graph; export a {nodes: [...]} (got ${describe(loaded.graph)})`,
		);
	}
	return {programs: rows as ProgramRows, graph: loaded.graph} satisfies LoadedConfig;
});
