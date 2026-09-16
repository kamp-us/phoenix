/**
 * `config schema` — reconcile the committed schema files with the registry, or render them.
 *
 * Two documents, one registry: `.fabrika.schema.json` describes the whole tracked config, and
 * `.fabrika.local.schema.json` describes the machine-local subset of it. Default is the check: it
 * reds when a committed file's content differs from the document assembled from the key fragments,
 * so neither file can silently fall behind a new key or a newly admitted machine-local one.
 * `--write` is the generator, and the reason the check is not a hand-sync chore — each schema has a
 * single writer.
 *
 * The files arrive as injected reads and saving is an injected write, so both refusal paths run in
 * a test without a filesystem. A file that could not be read is UNKNOWN (`6`), never "the schema
 * drifts": those two are the pair this reconcile keeps apart. An absent file, by contrast, is a
 * proven drift — the schema was never committed — not an UNKNOWN.
 *
 * A repo root nobody located sits on the UNKNOWN side of that same pair, and is refused ahead of
 * either leg: probing under a root the discovery failed to resolve would report whatever directory
 * the caller stood in as "the schema is not committed", and `--write` would render the file there.
 * `repoConfigSource` (`./working-root.ts`) keeps the pair apart the same way for the config itself.
 *
 * **The first disagreeing document refuses the run.** A partial pass is not an answer a caller can
 * act on differently: the remedy for either is the same `--write`, and reporting one file's drift
 * while the other's went unchecked is the reading a per-file green invites.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9020#issuecomment-5625285600
 */

import {Effect} from "effect";
import {parseJson} from "../io/json.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_REGISTRY, IO_UNKNOWN, SCHEMA_DRIFT} from "./codes.ts";
import {
	assembleLocalSchema,
	assembleSchema,
	CONFIG_SCHEMA_FILE,
	type ConfigSchemaDocument,
	LOCAL_CONFIG_SCHEMA_FILE,
	schemaMatches,
	serializeSchema,
} from "./json-schema.ts";
import type {Registration} from "./key-group.ts";

const VERB = "config schema";

/**
 * Where the committed files sit, or the reason nobody located a root to look under.
 *
 * A discovery that *failed* is `Unlocated`. A discovery that succeeded and found no repo root is
 * not: that is a real directory holding no schema file, and an answer about it is a proven one.
 */
export type SchemaRoot =
	| {readonly _tag: "Root"; readonly root: string}
	| {readonly _tag: "Unlocated"; readonly reason: string};

/** A committed file's bytes, its proven absence, or the reason they were never seen. */
export type SchemaRead =
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Failed"; readonly reason: string};

export type SchemaSave =
	| {readonly _tag: "Saved"}
	| {readonly _tag: "Failed"; readonly reason: string};

export interface SchemaOptions<R> {
	readonly write: boolean;
	readonly json: boolean;
	readonly registrations: ReadonlyArray<Registration>;
	readonly root: SchemaRoot;
	readonly read: (root: string, file: string) => Effect.Effect<SchemaRead, never, R>;
	readonly save: (root: string, file: string, text: string) => Effect.Effect<SchemaSave, never, R>;
}

type Outcome = "agrees" | "written";

/** One reconciled document: which file it lands in, and how many keys it admits. */
interface FileResult {
	readonly file: string;
	readonly outcome: Outcome;
	readonly keys: number;
}

/** A document's key count is its own properties minus the `$schema` self-pointer. */
const keyCount = (schema: ConfigSchemaDocument): number =>
	Object.keys(schema.properties).filter((key) => key !== "$schema").length;

const verdict = (
	json: boolean,
	outcome: Outcome,
	keys: number,
	files: ReadonlyArray<FileResult>,
) =>
	json
		? `${JSON.stringify({outcome, keys, files})}\n`
		: `${[
				`schema\t${outcome}\t${keys}`,
				...files.map((one) => `file\t${one.file}\t${one.outcome}\t${one.keys}`),
			].join("\n")}\n`;

export const runSchema = <R>({
	write,
	json,
	registrations,
	root,
	read,
	save,
}: SchemaOptions<R>): Effect.Effect<VerbOutcome, never, R> =>
	Effect.gen(function* () {
		const documents = [
			{file: CONFIG_SCHEMA_FILE, assembly: assembleSchema(registrations)},
			{file: LOCAL_CONFIG_SCHEMA_FILE, assembly: assembleLocalSchema(registrations)},
		];
		const scope = `${VERB}: assembled ${registrations.length} key fragment(s) into ${documents.map((one) => one.file).join(" and ")}.`;

		for (const {assembly} of documents) {
			if (assembly._tag === "Incomplete") {
				return refuse(
					INCOMPLETE_REGISTRY,
					`${VERB}: ${assembly.missing.length} registered key(s) carry no schema fragment (${assembly.missing.join(", ")}) — the schema would green a typo under each, so it is not emitted.`,
					[scope],
				);
			}
		}

		if (root._tag === "Unlocated") {
			return refuse(
				IO_UNKNOWN,
				`${VERB}: the repository root could not be resolved — UNKNOWN, never "the schema drifts": ${root.reason}`,
				[scope],
			);
		}

		const files: Array<FileResult> = [];
		for (const {file, assembly} of documents) {
			if (assembly._tag !== "Complete") continue;
			const keys = keyCount(assembly.schema);

			if (write) {
				const saved = yield* save(root.root, file, serializeSchema(assembly.schema));
				if (saved._tag === "Failed") {
					return refuse(IO_UNKNOWN, `${VERB}: ${file} could not be written: ${saved.reason}`, [
						scope,
					]);
				}
				files.push({file, outcome: "written", keys});
				continue;
			}

			const source = yield* read(root.root, file);
			if (source._tag === "Failed") {
				return refuse(
					IO_UNKNOWN,
					`${VERB}: ${file} could not be read — UNKNOWN, never "the schema drifts": ${source.reason}`,
					[scope],
				);
			}
			if (source._tag === "Absent") {
				return refuse(
					SCHEMA_DRIFT,
					`${VERB}: ${file} is not committed — run \`${VERB} --write\` to generate it.`,
					[scope],
				);
			}

			const committed = parseJson(source.text);
			if (committed === null || !schemaMatches(committed, assembly.schema)) {
				return refuse(
					SCHEMA_DRIFT,
					`${VERB}: ${file} is stale — regenerate it with \`${VERB} --write\`.`,
					[scope],
				);
			}
			files.push({file, outcome: "agrees", keys});
		}

		return answer(verdict(json, write ? "written" : "agrees", registrations.length, files), [
			scope,
		]);
	});
