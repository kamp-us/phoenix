/**
 * The spell registry: one table of every callable spell, addressed by path, replaced whole.
 *
 * The table lives behind a single `Ref` and `swap` is a single write, so a config reload replaces
 * every program's spells at once and a reader never observes half a table (#7617 R1.2). Registering
 * is `buildRegistry`, a pure function over the core list and the program rows; the service only
 * holds what it produced.
 */

import {Context, Effect, type JsonSchema, Layer, Ref, Schema} from "effect";
import type {AnyProgram, CapabilityRequest, ProgramId} from "../registry/program.ts";
import {DuplicateSpellPath, SpellNotFound} from "./errors.ts";
import {type AnySpell, renderPath, type SpellPath} from "./spell.ts";

/** Where a registered spell came from. A refusal names both sides through `describeSource`. */
export type SpellSource =
	| {readonly kind: "core"}
	| {readonly kind: "program"; readonly programId: ProgramId};

export const describeSource = (source: SpellSource): string =>
	source.kind === "core" ? "the core spell list" : `program "${source.programId}"`;

/** One registered spell at its effective path — a program's spell is pathed under its program id. */
export interface SpellRow {
	readonly path: SpellPath;
	readonly source: SpellSource;
	readonly spell: AnySpell;
}

/** A node of the path trie. A node carries a row when a spell is registered at exactly its path. */
export interface SpellNode {
	readonly children: ReadonlyMap<string, SpellNode>;
	readonly row?: SpellRow;
}

/** The whole table: the trie `lookup` walks, plus the flat list `list` and `describe` read. */
export interface RegistryTable {
	readonly root: SpellNode;
	readonly rows: ReadonlyArray<SpellRow>;
}

/** The serializable face of one spell: what a client is told without being handed the closure. */
export interface SpellDescription {
	readonly path: ReadonlyArray<string>;
	readonly describe: string;
	readonly params: JsonSchema.Document<"draft-2020-12">;
	readonly capabilities: ReadonlyArray<CapabilityRequest>;
}

export const describeSpell = (row: SpellRow): SpellDescription => ({
	path: [...row.path],
	describe: row.spell.describe,
	params: Schema.toJsonSchemaDocument(row.spell.params),
	capabilities: [...row.spell.capabilities],
});

interface MutableNode {
	readonly children: Map<string, MutableNode>;
	row?: SpellRow;
}

const freeze = (node: MutableNode): SpellNode => {
	const children = new Map<string, SpellNode>(
		[...node.children].map(([segment, child]) => [segment, freeze(child)]),
	);
	return node.row === undefined ? {children} : {children, row: node.row};
};

/**
 * The table over the core spells and the program rows. Building it is registration: two spells
 * claiming one path fail with `DuplicateSpellPath`, naming the path and both sources.
 */
export const buildRegistry = Effect.fn("Tuval.Commands.buildRegistry")(function* (input: {
	readonly core: ReadonlyArray<AnySpell>;
	readonly programs: ReadonlyArray<AnyProgram>;
}) {
	const root: MutableNode = {children: new Map()};
	const rows: Array<SpellRow> = [];

	const claim = (row: SpellRow): Effect.Effect<void, DuplicateSpellPath> => {
		let node = root;
		for (const segment of row.path) {
			const child = node.children.get(segment) ?? {children: new Map<string, MutableNode>()};
			node.children.set(segment, child);
			node = child;
		}
		if (node.row !== undefined) {
			return Effect.fail(
				new DuplicateSpellPath({
					path: renderPath(row.path),
					first: describeSource(node.row.source),
					second: describeSource(row.source),
				}),
			);
		}
		node.row = row;
		rows.push(row);
		return Effect.void;
	};

	for (const spell of input.core) {
		yield* claim({path: spell.path, source: {kind: "core"}, spell});
	}
	for (const program of input.programs) {
		for (const spell of program.spells ?? []) {
			yield* claim({
				path: [program.id, ...spell.path],
				source: {kind: "program", programId: program.id},
				spell,
			});
		}
	}

	return {root: freeze(root), rows} satisfies RegistryTable;
});

const make = Effect.fn("Tuval.SpellRegistry.make")(function* (initial: RegistryTable) {
	// Every read below is one `Ref.get`, so a read either precedes `swap`'s single write or
	// follows it; there is no window in which a reader walks a half-replaced table.
	const table = yield* Ref.make(initial);
	return SpellRegistry.of({
		lookup: (path) =>
			Effect.flatMap(Ref.get(table), (current) => {
				let node: SpellNode | undefined = current.root;
				for (const segment of path) {
					node = node.children.get(segment);
					if (node === undefined) break;
				}
				return node?.row === undefined
					? Effect.fail(new SpellNotFound({path: renderPath(path)}))
					: Effect.succeed(node.row);
			}),
		list: Effect.map(Ref.get(table), (current) => current.rows),
		describe: Effect.map(Ref.get(table), (current) => current.rows.map(describeSpell)),
		swap: (next) => Ref.set(table, next),
	});
});

export class SpellRegistry extends Context.Service<
	SpellRegistry,
	{
		readonly lookup: (path: SpellPath) => Effect.Effect<SpellRow, SpellNotFound>;
		readonly list: Effect.Effect<ReadonlyArray<SpellRow>>;
		readonly describe: Effect.Effect<ReadonlyArray<SpellDescription>>;
		readonly swap: (table: RegistryTable) => Effect.Effect<void>;
	}
>()("tuval/SpellRegistry") {
	/** The registry over one already-built table. */
	static readonly layer = (initial: RegistryTable): Layer.Layer<SpellRegistry> =>
		Layer.effect(SpellRegistry, make(initial));

	/** The registry over a bare core spell list — the test seam, no program rows involved. */
	static readonly scripted = (
		spells: ReadonlyArray<AnySpell>,
	): Layer.Layer<SpellRegistry, DuplicateSpellPath> =>
		Layer.effect(SpellRegistry, Effect.flatMap(buildRegistry({core: spells, programs: []}), make));
}
