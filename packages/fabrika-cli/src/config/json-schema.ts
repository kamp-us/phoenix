/**
 * The document-level JSON Schemas for the two config files, assembled from the per-key fragments.
 *
 * Each key group carries its own `jsonSchema` fragment beside its `decode`, so the shape a repo
 * hand-edits is described in the one place its decoder already lives. This module joins the registry's
 * fragments into one draft-07 document an editor validates the file against — a red squiggle on a
 * misspelled key or a wrong-typed value, where the only feedback used to be a decode failure at
 * runtime.
 *
 * **A registered key with no fragment refuses the assembly whole.** A schema missing one key's
 * properties would green a typo in that key's subtree, which is the silent gap this schema exists to
 * close; so an incomplete registry is named, never emitted over.
 *
 * The machine-local document is the same assembly narrowed to the keys a machine may declare, so an
 * editor reds an ineligible key where it is typed rather than at the next verb run.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9020#issuecomment-5625285600
 */

import type {Registration} from "./key-group.ts";
import {machineLocalKeys} from "./machine-local.ts";

/** The JSON Schema keywords the fragments use. Not the whole vocabulary — only what a fragment reaches for. */
export type JsonSchemaType =
	| "object"
	| "array"
	| "string"
	| "number"
	| "integer"
	| "boolean"
	| "null";

export interface JsonSchema {
	readonly type?: JsonSchemaType | ReadonlyArray<JsonSchemaType>;
	readonly description?: string;
	readonly enum?: ReadonlyArray<string>;
	readonly pattern?: string;
	readonly minLength?: number;
	readonly minimum?: number;
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: ReadonlyArray<string>;
	readonly additionalProperties?: boolean | JsonSchema;
	readonly propertyNames?: JsonSchema;
	readonly items?: JsonSchema;
	readonly minItems?: number;
	readonly uniqueItems?: boolean;
}

/** The meta-schema the emitted document declares itself against — draft-07, which editors resolve. */
export const META_SCHEMA = "http://json-schema.org/draft-07/schema#";

/** The `$schema` pointer a repo writes into `.fabrika.jsonc` to bind it to the committed schema file. */
export const CONFIG_SCHEMA_FILE = ".fabrika.schema.json";

/**
 * The committed schema for the machine-local file.
 *
 * Committed although the file it describes never is: the schema is derived from this repository's
 * registry and is the same on every machine, and a gitignored schema would have to be regenerated
 * by hand on each one.
 */
export const LOCAL_CONFIG_SCHEMA_FILE = ".fabrika.local.schema.json";

export interface ConfigSchemaDocument {
	readonly $schema: string;
	readonly title: string;
	readonly description: string;
	readonly type: "object";
	readonly properties: Readonly<Record<string, JsonSchema>>;
	readonly additionalProperties: false;
}

export type Assembly =
	/** Every registered key carried a fragment; this is the document to emit. */
	| {readonly _tag: "Complete"; readonly schema: ConfigSchemaDocument}
	/** One or more registered keys carry no fragment — the assembly is refused, naming them. */
	| {readonly _tag: "Incomplete"; readonly missing: ReadonlyArray<string>};

/**
 * The `$schema` self-pointer, admitted as a known property so `additionalProperties: false` does not
 * red the very line that binds the file to this schema.
 */
const pointerFragment = (file: string): JsonSchema => ({
	type: "string",
	description: `Path to the JSON Schema for this file — e.g. "./${file}". Gives an editor autocomplete and validation for the keys below.`,
});

/**
 * Assemble one document from the registry, in registry order, over the keys `admits` keeps.
 *
 * The completeness check runs over the **whole** registry rather than the admitted subset: a key
 * added with no fragment refuses here rather than shipping a schema that silently permits anything
 * under its key, and a narrowed document that skipped the check would green the tracked file's gap.
 * That is why the field is optional on the type but required in practice — the assembler holds the
 * rule a `?` cannot.
 */
const assemble = (
	registrations: ReadonlyArray<Registration>,
	admits: (one: Registration) => boolean,
	document: {readonly file: string; readonly title: string; readonly description: string},
): Assembly => {
	const missing = registrations.filter((one) => one.jsonSchema === undefined).map((one) => one.key);
	if (missing.length > 0) return {_tag: "Incomplete", missing};

	const properties: Record<string, JsonSchema> = {$schema: pointerFragment(document.file)};
	for (const one of registrations) {
		if (one.jsonSchema !== undefined && admits(one)) properties[one.key] = one.jsonSchema;
	}

	return {
		_tag: "Complete",
		schema: {
			$schema: META_SCHEMA,
			title: document.title,
			description: document.description,
			type: "object",
			properties,
			additionalProperties: false,
		},
	};
};

/** The whole config surface — the document an editor validates the tracked file against. */
export const assembleSchema = (registrations: ReadonlyArray<Registration>): Assembly =>
	assemble(registrations, () => true, {
		file: CONFIG_SCHEMA_FILE,
		title: "fabrika config (.fabrika.jsonc)",
		description:
			"Every key fabrika reads from .fabrika.jsonc. Each is independently optional and falls to its shipped default when absent; this schema documents the shape of a declared value. Generated by `fabrika config schema --write` — edit the key fragments in packages/fabrika-cli/src/config/keys/, never this file.",
	});

/**
 * The machine-local subset — the document an editor validates the gitignored file against.
 *
 * `additionalProperties: false` over the narrowed property set is what makes an ineligible key red
 * in the editor. It is the same fact the loader refuses on, stated where the key is typed; the
 * loader stays the gate, because a schema is advice an editor may not be running.
 */
export const assembleLocalSchema = (registrations: ReadonlyArray<Registration>): Assembly => {
	const eligible = new Set(machineLocalKeys(registrations));
	return assemble(registrations, (one) => eligible.has(one.key), {
		file: LOCAL_CONFIG_SCHEMA_FILE,
		title: "fabrika machine-local config (.fabrika.local.jsonc)",
		description:
			"The keys one machine may declare in the gitignored .fabrika.local.jsonc, layered over the tracked .fabrika.jsonc. A key absent here is one no machine may set locally, and declaring it refuses the whole config load rather than being ignored. Generated by `fabrika config schema --write` — edit the key fragments in packages/fabrika-cli/src/config/keys/, never this file.",
	});
};

/** The committed schema serialized the way `--write` lands it — tab-indented, one trailing newline. */
export const serializeSchema = (schema: ConfigSchemaDocument): string =>
	`${JSON.stringify(schema, null, "\t")}\n`;

/**
 * Whether a committed schema document matches the assembled one.
 *
 * Whitespace-insensitive, key-order sensitive: the two compact serializations are compared, so a
 * re-indented file still agrees while a re-ordered one reds. That is the strict direction, and the
 * generator is the only writer — `--write` emits the registry's order every time.
 */
export const schemaMatches = (committed: unknown, assembled: ConfigSchemaDocument): boolean =>
	JSON.stringify(committed) === JSON.stringify(assembled);
