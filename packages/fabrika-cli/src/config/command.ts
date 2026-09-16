/**
 * The `config` verb group — `fabrika config <verb>`.
 *
 * The adapter and nothing else: it resolves the repo root, reads or writes the committed schema file,
 * runs the pure verb, and emits its outcome. Every decision lives in `./schema-verb.ts` beside it.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form
 * silently opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */

import {Effect, type FileSystem, type Path, Result} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {discoverRepoRoot} from "../delegate/root.ts";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {exists, readFile, writeFile} from "../io/fs.ts";
import {CONFIG_SCHEMA_FILE, LOCAL_CONFIG_SCHEMA_FILE} from "./json-schema.ts";
import {KEY_GROUPS} from "./registry.ts";
import {runSchema, type SchemaRead, type SchemaRoot, type SchemaSave} from "./schema-verb.ts";

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

/**
 * The root the schema file sits at — or the reason nobody located one.
 *
 * A discovery that failed is handed on as `Unlocated` rather than swallowed into the cwd, because
 * `runSchema` is the module that decides what a root nobody located means, and it answers UNKNOWN.
 * A discovery that succeeded and found no repo root still falls to the cwd: that is a real
 * directory, and its answer is a proven one either way (the shape `repoConfigSource` already uses).
 */
const schemaRoot: Effect.Effect<SchemaRoot, never, FileSystem.FileSystem | Path.Path> = Effect.gen(
	function* () {
		const cwd = process.cwd();
		const found = yield* Effect.result(discoverRepoRoot(cwd));
		return found._tag === "Failure"
			? {
					_tag: "Unlocated",
					reason: `cannot resolve the repo root above ${cwd}: ${found.failure.reason}`,
				}
			: {_tag: "Root", root: found.success ?? cwd};
	},
);

/** One committed schema as its caller found it — absent, read, or unreadable, kept apart. */
const readSchemaFile = (
	root: string,
	file: string,
): Effect.Effect<SchemaRead, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const path = `${root}/${file}`;
		const probe = yield* Effect.result(exists(path));
		if (Result.isFailure(probe)) return {_tag: "Failed", reason: probe.failure.reason};
		if (!probe.success) return {_tag: "Absent"};
		const text = yield* Effect.result(readFile(path));
		return Result.isFailure(text)
			? {_tag: "Failed", reason: text.failure.reason}
			: {_tag: "Text", text: text.success};
	});

const saveSchemaFile = (
	root: string,
	file: string,
	content: string,
): Effect.Effect<SchemaSave, never, FileSystem.FileSystem | Path.Path> =>
	Effect.map(Effect.result(writeFile(`${root}/${file}`, content)), (written) =>
		Result.isFailure(written)
			? ({_tag: "Failed", reason: written.failure.reason} satisfies SchemaSave)
			: ({_tag: "Saved"} satisfies SchemaSave),
	);

const schema = leafCommand(
	"schema",
	{
		write: Flag.boolean("write").pipe(
			Flag.withDescription(
				`render ${CONFIG_SCHEMA_FILE} and ${LOCAL_CONFIG_SCHEMA_FILE} from the registry again, instead of only reconciling them`,
			),
		),
		json: jsonFlag,
	},
	Effect.fn(function* ({write, json}) {
		yield* emit(
			yield* runSchema<FileSystem.FileSystem | Path.Path>({
				write,
				json,
				registrations: KEY_GROUPS,
				root: yield* schemaRoot,
				read: readSchemaFile,
				save: saveSchemaFile,
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		`Reconcile ${CONFIG_SCHEMA_FILE} and ${LOCAL_CONFIG_SCHEMA_FILE} with the config-key registry.`,
	),
	Command.withDescription(
		`Reconcile the two committed schema files with the JSON Schemas assembled from the config-key fragments — and, with --write, render them from the registry rather than by hand, so an editor validates .fabrika.jsonc and the gitignored .fabrika.local.jsonc against them. ${CONFIG_SCHEMA_FILE} covers the whole surface; ${LOCAL_CONFIG_SCHEMA_FILE} covers the machine-local subset, so an editor reds a key no machine may set locally where it is typed. Stdout is \`schema\\t<agrees|written>\\t<keys>\` followed by one \`file\\t<path>\\t<agrees|written>\\t<keys>\` line per document. Exits 4 (a committed file is stale or not committed — regenerate with --write), 6 (the repo root could not be resolved, or a file could not be read or written — UNKNOWN, never drift), 7 (a registered key carries no schema fragment, so the schema would be incomplete). Example: fabrika config schema --write`,
	),
);

export const configCommand = Command.make("config").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		schema,
	]),
	Command.withShortDescription(
		"Reconcile the shape of the config files with the config-key registry.",
	),
	Command.withDescription(
		"Own the derived shape of the config files — assemble the per-key JSON Schema fragments into the documents an editor validates .fabrika.jsonc and the machine-local .fabrika.local.jsonc against, and keep the committed schemas rendered from the registry",
	),
);
