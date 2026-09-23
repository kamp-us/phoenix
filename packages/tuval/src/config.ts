/**
 * The shape of a user-owned config module: one versioned Schema a module's default export decodes
 * against, and `TuvalConfigInput`, the type a config author annotates that export with.
 *
 * The shape lives in the SDK and the loader does not. A config is written against the shape by
 * whoever owns it, in or out of phoenix, and it names harness packages beside this one; the desk
 * app that loads, merges and boots it is not importable (#9656). The loader and the two-layer
 * merge are `apps/tuval/src/config.ts`'s.
 *
 * Program rows stay opaque beyond the `id` the merge keys on — the row type is the registry
 * slice's, and Schema would strip a row's machine and handlers as excess keys. The graph is
 * decoded structurally; the ports slice refuses a malformed one when it compiles.
 */

import {Effect, Predicate, Schema} from "effect";
import {KeyBindings} from "./commands/bindings/index.ts";
import {featuresDefault, type TuvalFeatures} from "./features.ts";
import {NodeId} from "./ports/graph.ts";
import {ProgramId} from "./registry/program.ts";

const hasStringId = (row: unknown): row is {readonly id: string} =>
	Predicate.isObject(row) && Predicate.isString((row as {readonly id?: unknown}).id);

const ProgramRow = Schema.Unknown.check(
	Schema.makeFilter(hasStringId, {message: "Expected a program row with a string id"}),
);

const PortRef = Schema.Struct({node: NodeId, port: Schema.String});

const GraphNode = Schema.Struct({
	id: NodeId,
	program: ProgramId,
	parent: Schema.optionalKey(NodeId),
	on: Schema.Array(Schema.Struct({port: Schema.String, to: PortRef})),
});

const GraphSchema = Schema.Struct({nodes: Schema.Array(GraphNode)});

/**
 * The feature flags a layer *states*, one optional boolean key per key of `TuvalFeatures`. Every
 * key is optional, and that is the whole point: absent means "this layer says nothing", not "off",
 * so a project layer naming one flag cannot put back to its default a flag the global layer turned
 * on. `featuresDefault` is where a flag nobody stated lands.
 *
 * Derived rather than hand-listed, because hand-listing drifted twice: a key on `TuvalFeatures`
 * that nobody re-typed here was dropped by the decode, so a layer stating it moved the browser and
 * nothing on the node side (#8595, #8783). The mapped type takes the key set from `TuvalFeatures`
 * and the runtime fields from `featuresDefault`'s own keys, and `featuresDefault` is annotated
 * `TuvalFeatures`, so the two cannot name different keys.
 */
type DeclaredFeatureFields = {
	readonly [K in keyof TuvalFeatures]: Schema.optionalKey<typeof Schema.Boolean>;
};

const declaredFeatureFields = Object.fromEntries(
	Object.keys(featuresDefault).map((key) => [key, Schema.optionalKey(Schema.Boolean)]),
) as DeclaredFeatureFields;

export const DeclaredFeatures = Schema.Struct(declaredFeatureFields);

/** Version 1 of the config shape. A config module default-exports its `Encoded` form. */
export const TuvalConfig = Schema.Struct({
	version: Schema.Literal(1),
	programs: Schema.Array(ProgramRow),
	features: DeclaredFeatures.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
	graph: GraphSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed({nodes: []}))),
	/** Key to command string, read by the parser and compiled against the registry at boot. */
	keys: KeyBindings.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});

export type TuvalConfig = typeof TuvalConfig.Type;
/** What a config module writes: plain strings for the ids, `graph` optional. */
export type TuvalConfigInput = typeof TuvalConfig.Encoded;
