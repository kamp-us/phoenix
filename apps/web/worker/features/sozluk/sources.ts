/**
 * Sözlük fate sources — `Term` / `Definition` Effect-backed loaders. fate is
 * pure transport (ADR 0016); every handler delegates to a `Sozluk` method. Only
 * `byId`/`byIds` are implemented (the relation workhorse that avoids the N+1);
 * connections come from custom resolvers (ADR 0019). Reads are silent and
 * `E = never` — see `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@kampus/fate-effect";
import {currentSandboxViewer} from "../kunye/sandbox.ts";
import {Sozluk} from "./Sozluk.ts";
import {DefinitionView, TermView} from "./views.ts";

export const definitionSource = Fate.source(
	DefinitionView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const sozluk = yield* Sozluk;
			const sandboxViewer = yield* currentSandboxViewer;
			return yield* sozluk.getDefinitionsByIds(ids, {
				viewerId: sandboxViewer.viewerId,
				sandboxViewer,
			});
		},
	},
);

export const termSource = Fate.source(
	TermView,
	{id: "slug"},
	{
		byIds: function* (slugs) {
			const sozluk = yield* Sozluk;
			return yield* sozluk.getTermSummariesByIds(slugs);
		},
	},
);
