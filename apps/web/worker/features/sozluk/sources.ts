/**
 * Sözlük fate sources — `Term` / `Definition` Effect-backed loaders. fate is
 * pure transport (ADR 0016); every handler delegates to a `Sozluk` method. Only
 * `byId`/`byIds` are implemented (the relation workhorse that avoids the N+1);
 * connections come from custom resolvers (ADR 0019). Reads are silent and
 * `E = never` — see `.patterns/fate-effect-sources.md`.
 */
import {CurrentUser, Fate} from "@kampus/fate-effect";
import {Sozluk} from "./Sozluk.ts";
import {DefinitionView, TermView} from "./views.ts";

export const definitionSource = Fate.source(
	DefinitionView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const sozluk = yield* Sozluk;
			const {user} = yield* CurrentUser;
			return yield* sozluk.getDefinitionsByIds(ids, {viewerId: user?.id ?? null});
		},
	},
);

export const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byId: function* (slug) {
			const sozluk = yield* Sozluk;
			const rows = yield* sozluk.getTermSummariesByIds([slug]);
			return rows[0] ?? null;
		},
		byIds: function* (slugs) {
			const sozluk = yield* Sozluk;
			return yield* sozluk.getTermSummariesByIds(slugs);
		},
	},
);
