/**
 * Sözlük fate sources — `Term` / `Definition` Effect-backed loaders. fate is
 * pure transport (ADR 0016); every handler delegates to a `Sozluk` method. Only
 * `byId`/`byIds` are implemented (the relation workhorse that avoids the N+1);
 * connections come from custom resolvers (ADR 0019). Reads are silent and
 * `E = never` — see `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@kampus/fate-effect";
import {PHOENIX_SOZLUK_STAMP_WAVE} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
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
			// The read-path collapse is contained behind its default-off flag (#2709): off ⇒
			// the stamps run serially (today), on ⇒ one concurrent wave. Same wire output.
			const flags = yield* Flags;
			const parallelStamps = yield* flags
				.getBoolean(PHOENIX_SOZLUK_STAMP_WAVE, false)
				.pipe(provideRequestFlags);
			return yield* sozluk.getDefinitionsByIds(ids, {
				viewerId: sandboxViewer.viewerId,
				sandboxViewer,
				parallelStamps,
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
