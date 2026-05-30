/**
 * Sözlük fate source executors — `Term` / `Definition` Effect-backed reads.
 *
 * fate is pure transport (ADR 0016): it never queries D1. Every source executor
 * delegates to an Effect service method through {@link fateSource}, so all read
 * logic stays in the domain layer. `byId`/`byIds` are the only executors
 * implemented — the relation workhorse (avoids the N+1) that also backs live
 * relation masking; connections come from custom resolvers (ADR 0019).
 *
 * See `.patterns/fate-sources.md`.
 */
import {
	type AnyDataView,
	type AnySourceDefinition,
	fateSource,
	type SourceExecutor,
} from "../fate/effect.ts";
import {Auth} from "../pasaport/Auth.ts";
import {type DefinitionRow, Sozluk, type TermSummaryRow} from "./Sozluk.ts";
import {definitionDataView, termDataView} from "./views.ts";

type DefinitionViewRow = {[K in keyof DefinitionRow]: DefinitionRow[K]};
type TermViewRow = {[K in keyof TermSummaryRow]: TermSummaryRow[K]};

export const definitionExecutor: SourceExecutor = fateSource<DefinitionViewRow>({
	byIds: function* (ids) {
		const sozluk = yield* Sozluk;
		const auth = yield* Auth;
		return yield* sozluk.getDefinitionsByIds(ids, {viewerId: auth.user?.id ?? null});
	},
});

export const termExecutor: SourceExecutor = fateSource<TermViewRow>({
	byId: function* (slug) {
		const sozluk = yield* Sozluk;
		const rows = yield* sozluk.getTermSummariesByIds([slug]);
		return rows[0] ?? null;
	},
	byIds: function* (slugs) {
		const sozluk = yield* Sozluk;
		return yield* sozluk.getTermSummariesByIds(slugs);
	},
});

// SourceDefinitions are plain object literals — no factory call. `id` is the PK
// field name (`slug` for Term, `id` elsewhere), `view` is the base data view.
export const definitionSource: AnySourceDefinition = {
	id: "id",
	view: definitionDataView as AnyDataView,
};

export const termSource: AnySourceDefinition = {id: "slug", view: termDataView as AnyDataView};
