/**
 * `config schema` — reconcile the committed `.fabrika.schema.json` with the registry, or render it.
 *
 * Default is the check: it reds when the committed file's content differs from the schema assembled
 * from the fifteen key fragments, so the file can never silently fall behind a new key. `--write` is
 * the generator, and the reason the check is not a hand-sync chore — the schema has a single writer.
 *
 * The file arrives as an injected read and saving is an injected write, so both refusal paths run in
 * a test without a filesystem. A file that could not be read is UNKNOWN (`6`), never "the schema
 * drifts": those two are the pair this reconcile keeps apart. An absent file, by contrast, is a
 * proven drift — the schema was never committed — not an UNKNOWN.
 *
 * A repo root nobody located sits on the UNKNOWN side of that same pair, and is refused ahead of
 * either leg: probing under a root the discovery failed to resolve would report whatever directory
 * the caller stood in as "the schema is not committed", and `--write` would render the file there.
 * `repoConfigSource` (`./working-root.ts`) keeps the pair apart the same way for `.fabrika.jsonc`.
 */

import {Effect} from "effect";
import {parseJson} from "../io/json.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_REGISTRY, IO_UNKNOWN, SCHEMA_DRIFT} from "./codes.ts";
import {assembleSchema, CONFIG_SCHEMA_FILE, schemaMatches, serializeSchema} from "./json-schema.ts";
import type {Registration} from "./key-group.ts";

const VERB = "config schema";

/**
 * Where the committed file sits, or the reason nobody located a root to look under.
 *
 * A discovery that *failed* is `Unlocated`. A discovery that succeeded and found no repo root is
 * not: that is a real directory holding no schema file, and an answer about it is a proven one.
 */
export type SchemaRoot =
	| {readonly _tag: "Root"; readonly root: string}
	| {readonly _tag: "Unlocated"; readonly reason: string};

/** The committed file's bytes, its proven absence, or the reason they were never seen. */
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
	readonly read: (root: string) => Effect.Effect<SchemaRead, never, R>;
	readonly save: (root: string, text: string) => Effect.Effect<SchemaSave, never, R>;
}

const verdict = (json: boolean, outcome: "agrees" | "written", keys: number): string =>
	json
		? `${JSON.stringify({file: CONFIG_SCHEMA_FILE, outcome, keys})}\n`
		: `schema\t${outcome}\t${keys}\n`;

export const runSchema = <R>({
	write,
	json,
	registrations,
	root,
	read,
	save,
}: SchemaOptions<R>): Effect.Effect<VerbOutcome, never, R> =>
	Effect.gen(function* () {
		const assembly = assembleSchema(registrations);
		const scope = `${VERB}: assembled ${registrations.length} key fragment(s) into ${CONFIG_SCHEMA_FILE}.`;

		if (assembly._tag === "Incomplete") {
			return refuse(
				INCOMPLETE_REGISTRY,
				`${VERB}: ${assembly.missing.length} registered key(s) carry no schema fragment (${assembly.missing.join(", ")}) — the schema would green a typo under each, so it is not emitted.`,
				[scope],
			);
		}

		if (root._tag === "Unlocated") {
			return refuse(
				IO_UNKNOWN,
				`${VERB}: the repository root could not be resolved — UNKNOWN, never "the schema drifts": ${root.reason}`,
				[scope],
			);
		}

		const keys = registrations.length;

		if (write) {
			const saved = yield* save(root.root, serializeSchema(assembly.schema));
			if (saved._tag === "Failed") {
				return refuse(
					IO_UNKNOWN,
					`${VERB}: ${CONFIG_SCHEMA_FILE} could not be written: ${saved.reason}`,
					[scope],
				);
			}
			return answer(verdict(json, "written", keys), [scope]);
		}

		const source = yield* read(root.root);
		if (source._tag === "Failed") {
			return refuse(
				IO_UNKNOWN,
				`${VERB}: ${CONFIG_SCHEMA_FILE} could not be read — UNKNOWN, never "the schema drifts": ${source.reason}`,
				[scope],
			);
		}
		if (source._tag === "Absent") {
			return refuse(
				SCHEMA_DRIFT,
				`${VERB}: ${CONFIG_SCHEMA_FILE} is not committed — run \`${VERB} --write\` to generate it.`,
				[scope],
			);
		}

		const committed = parseJson(source.text);
		if (committed === null || !schemaMatches(committed, assembly.schema)) {
			return refuse(
				SCHEMA_DRIFT,
				`${VERB}: ${CONFIG_SCHEMA_FILE} is stale — regenerate it with \`${VERB} --write\`.`,
				[scope],
			);
		}

		return answer(verdict(json, "agrees", keys), [scope]);
	});
