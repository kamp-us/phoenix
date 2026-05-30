/**
 * Hand-built `SourceResolver` — Effect-backed reads, composed across features.
 *
 * fate is pure transport (ADR 0016): it never queries D1. Per-feature source
 * executors live in their owning feature (`features/<feature>/sources.ts`); this
 * file composes them into the registry fate expects and exposes the
 * `{getSource, registry}` surface `server.ts` hands to `createFateServer`.
 *
 * `@nkzw/fate/server` does **not** re-export `createSourceDefinition` /
 * `getDataViewSourceConfig` / `createSourceRegistry` / `getBaseDataView` (only
 * the public `createDrizzleSourceAdapter`, which phoenix bans), so the three
 * pieces are built directly:
 *
 *   - each `SourceDefinition` is a plain object literal `{id, view, orderBy?}`,
 *   - the `registry` is a `new Map` keyed by the `SourceDefinition` *object*
 *     (fate looks executors up by object identity),
 *   - `getSource` resolves a view to its definition by `view.typeName`,
 *     returning the *same* object used as the registry key.
 *
 * Sources carry **no** `connection` executor or `orderBy` contract: every
 * connection — root *and* nested — is delivered by a custom resolver in
 * `queries.ts` / `lists.ts` calling the service keyset method directly
 * (ADR 0019). The keyset `ORDER BY` lives in the service; the view
 * `list(view, {orderBy})` mirrors it. See `.patterns/fate-connections.md` and
 * `.patterns/fate-sources.md`.
 */
import type {SourceDefinition, SourceRegistry} from "@nkzw/fate/server";
import {
	commentExecutor,
	commentSource,
	postExecutor,
	postSource,
	tagExecutor,
	tagSource,
} from "../pano/sources.ts";
import {profileExecutor, profileSource, userExecutor, userSource} from "../pasaport/sources.ts";
import {definitionExecutor, definitionSource, termExecutor, termSource} from "../sozluk/sources.ts";
import type {FateContext} from "./context.ts";
import type {AnyDataView, AnySourceDefinition} from "./effect.ts";

// The registry is a plain Map keyed by the SourceDefinition object (identity).
const registry: SourceRegistry<FateContext> = new Map([
	[userSource, userExecutor],
	[definitionSource, definitionExecutor],
	[termSource, termExecutor],
	[postSource, postExecutor],
	[commentSource, commentExecutor],
	[tagSource, tagExecutor],
	[profileSource, profileExecutor],
]);

// fate calls getSource with a base or list()-wrapped view; both share
// `typeName`, so resolve by typeName. It must return the *same* SourceDefinition
// object used as the registry key.
const sourcesByType = new Map<string, AnySourceDefinition>(
	[
		userSource,
		definitionSource,
		termSource,
		postSource,
		commentSource,
		tagSource,
		profileSource,
	].map((s) => [s.view.typeName, s]),
);

export const sources = {
	getSource: <Item extends Record<string, unknown>>(
		view: AnyDataView | SourceDefinition<Item, unknown>,
	): SourceDefinition<Item, unknown> => {
		const typeName = "view" in view ? view.view.typeName : view.typeName;
		const source = sourcesByType.get(typeName);
		if (!source) {
			throw new Error(`No source registered for '${typeName}'.`);
		}
		return source as SourceDefinition<Item, unknown>;
	},
	registry,
};
