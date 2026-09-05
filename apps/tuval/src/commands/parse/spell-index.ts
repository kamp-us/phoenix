/**
 * The registry as this module reads it: a path trie over `SpellDescription` rows, each spell's
 * parameters flattened to an ordered list.
 *
 * It is built from the protocol's `RegistryDescription` — the rows the kernel's
 * `SpellRegistry.describe` produces and a `Snapshot` carries — so the page and the kernel run this
 * parser over identical input and the palette can never accept what the kernel rejects (the
 * founder's 2026-09-03 walk on #7639). A `RegistryTable` would carry richer types and the page
 * cannot hold one: it has descriptions, never the spells' closures.
 *
 * `SpellDescription.params` is `Schema.Unknown` on the wire, and what actually arrives is the
 * spell's `params` as JSON Schema. Two properties of that rendering are load-bearing and both were
 * read off `Schema.toJsonSchemaDocument` at the `catalogs.tuval` pin (effect 4.0.0-rc.112): the
 * `properties` object's key order is the declaration order of `Schema.Struct`, which is the
 * positional order of the parameters, and a `Schema.Literals` parameter arrives as
 * `{"type": "string", "enum": [...]}`. A third followed from the same reading: a `Schema.Class` or
 * an identifier-annotated struct renders its root as `{"$ref": "#/$defs/<name>"}` with the object
 * itself under the document's `definitions`, so the root ref is followed once before the properties
 * are read. Everything else is read defensively — this module is total.
 */

import type {RegistryDescription} from "../../protocol/registry-description.ts";
import type {SpellPath} from "../spell.ts";

/** One parameter of a spell, as the parser binds it and the palette describes it. */
export interface ParamSpec {
	readonly name: string;
	readonly required: boolean;
	/** The literal choices when the parameter is an enum; a value outside them is refused. */
	readonly literals?: ReadonlyArray<string>;
}

export interface IndexedSpell {
	readonly path: SpellPath;
	readonly describe: string;
	readonly params: ReadonlyArray<ParamSpec>;
}

/** A node of the path trie. A node carries a spell when one is registered at exactly its path. */
export interface IndexNode {
	readonly children: ReadonlyMap<string, IndexNode>;
	readonly spell?: IndexedSpell;
}

export interface SpellIndex {
	readonly root: IndexNode;
	readonly spells: ReadonlyArray<IndexedSpell>;
}

/** The one-line expectation a refusal and the palette show for a parameter. */
export const describeExpected = (param: ParamSpec): string =>
	param.literals === undefined ? `<${param.name}>` : param.literals.join("|");

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const stringLiterals = (property: unknown): ReadonlyArray<string> | undefined => {
	const choices = asRecord(property)?.enum;
	if (!Array.isArray(choices) || choices.length === 0) return undefined;
	return choices.every((choice) => typeof choice === "string")
		? (choices as ReadonlyArray<string>)
		: undefined;
};

/**
 * The document's own definitions, under either spelling. `Schema.toJsonSchemaDocument` writes the
 * map as `definitions` and points at it with `#/$defs/…`, so both have to be read.
 */
const definitionsOf = (params: unknown): Record<string, unknown> => ({
	...asRecord(asRecord(params)?.$defs),
	...asRecord(asRecord(params)?.definitions),
});

const REF = /^#\/(?:\$defs|definitions)\/(.+)$/;

/**
 * The object schema a root `$ref` points at. A `Schema.Class` params, or any identifier-annotated
 * struct, renders as a bare `$ref` into the document's definitions (read off the renderer at the
 * `catalogs.tuval` pin), and a spell whose parameters live there has parameters like any other.
 */
const followRef = (schema: Record<string, unknown> | undefined, params: unknown) => {
	const ref = schema?.$ref;
	if (typeof ref !== "string") return schema;
	const name = REF.exec(ref)?.[1];
	if (name === undefined) return schema;
	return asRecord(definitionsOf(params)[decodeURIComponent(name)]) ?? schema;
};

export const readParams = (params: unknown): ReadonlyArray<ParamSpec> => {
	const root = asRecord(asRecord(params)?.schema) ?? asRecord(params);
	const schema = followRef(root, params);
	const properties = asRecord(schema?.properties);
	if (properties === undefined) return [];
	const declaredRequired = schema?.required;
	const required = new Set(
		Array.isArray(declaredRequired)
			? declaredRequired.filter((name): name is string => typeof name === "string")
			: [],
	);
	return Object.keys(properties).map((name) => {
		const literals = stringLiterals(properties[name]);
		return literals === undefined
			? {name, required: required.has(name)}
			: {name, required: required.has(name), literals};
	});
};

interface MutableNode {
	readonly children: Map<string, MutableNode>;
	spell?: IndexedSpell;
}

const freeze = (node: MutableNode): IndexNode => {
	const children = new Map<string, IndexNode>(
		[...node.children].map(([segment, child]) => [segment, freeze(child)]),
	);
	return node.spell === undefined ? {children} : {children, spell: node.spell};
};

export const buildSpellIndex = (descriptions: RegistryDescription): SpellIndex => {
	const root: MutableNode = {children: new Map()};
	const spells: Array<IndexedSpell> = [];

	for (const description of descriptions) {
		const path: SpellPath = description.path;
		const spell: IndexedSpell = {
			path,
			describe: description.describe,
			params: readParams(description.params),
		};
		let node = root;
		for (const segment of path) {
			const child = node.children.get(segment) ?? {children: new Map<string, MutableNode>()};
			node.children.set(segment, child);
			node = child;
		}
		node.spell = spell;
		spells.push(spell);
	}

	return {root: freeze(root), spells};
};
