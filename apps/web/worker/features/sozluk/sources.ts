/**
 * Sözlük fate sources — `Term` / `Definition` Effect-backed loaders.
 *
 * fate is pure transport (ADR 0016): it never queries D1. Every handler
 * delegates to a `Sozluk` method, so all read logic stays in the domain layer.
 * `byId`/`byIds` are the only capabilities implemented — the relation
 * workhorse (avoids the N+1) that also backs live relation masking;
 * connections come from custom resolvers (ADR 0019).
 *
 * The loader contract is in the types (`.patterns/fate-effect-sources.md`):
 * reads are silent (absence = `null`/fewer rows), `E = never` — the
 * `DrizzleError` channel is infrastructure, so it dies (`orDieDrizzle`)
 * instead of becoming a wire value.
 */
import {CurrentUser, Fate} from "@phoenix/fate-effect";
import {orDieDrizzle} from "../../db/Drizzle.ts";
import {Sozluk} from "./Sozluk.ts";
import {DefinitionView, TermView} from "./views.ts";

export const definitionSource = Fate.source(
	DefinitionView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const sozluk = yield* Sozluk;
			const {user} = yield* CurrentUser;
			return yield* sozluk
				.getDefinitionsByIds(ids, {viewerId: user?.id ?? null})
				.pipe(orDieDrizzle);
		},
	},
);

export const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byId: function* (slug) {
			const sozluk = yield* Sozluk;
			const rows = yield* sozluk.getTermSummariesByIds([slug]).pipe(orDieDrizzle);
			return rows[0] ?? null;
		},
		byIds: function* (slugs) {
			const sozluk = yield* Sozluk;
			return yield* sozluk.getTermSummariesByIds(slugs).pipe(orDieDrizzle);
		},
	},
);
