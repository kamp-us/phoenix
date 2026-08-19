/**
 * Pano fate sources. fate is pure transport (ADR 0016), so every handler delegates to
 * a `Pano` method. Reads are silent — absence is `null`/fewer rows, and `E = never`
 * because infra failures die inside the domain service.
 * See .patterns/fate-effect-sources.md.
 */
import {CurrentUser, Fate} from "@kampus/fate-effect";
import {PHOENIX_PANO_STAMP_WAVE} from "../../../src/flags/keys.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {currentSandboxViewer} from "../kunye/sandbox.ts";
import {currentMutedIds} from "../mute/read-mask.ts";
import {Pano, tagLabel} from "./Pano.ts";
import {CommentView, PostOverlayView, PostView, TagView} from "./views.ts";

export const postSource = Fate.source(
	PostView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const pano = yield* Pano;
			const sandboxViewer = yield* currentSandboxViewer;
			const mutedIds = yield* currentMutedIds;
			return yield* pano.getPostsByIds(ids, {
				viewerId: sandboxViewer.viewerId,
				sandboxViewer,
				mutedIds,
			});
		},
	},
);

// Session-gated by construction: it reads `CurrentUser` off the authed `POST /fate`
// edge, so nothing session-derived rides the cacheable base (ADR 0169). An anonymous
// viewer gets `null` scalars for every id.
export const postOverlaySource = Fate.source(
	PostOverlayView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const {user} = yield* CurrentUser;
			const viewerId = user?.id ?? null;
			if (!viewerId) {
				return ids.map((id) => ({id, myVote: null, isSaved: null}));
			}
			const pano = yield* Pano;
			return yield* pano.readViewerOverlay(ids, {viewerId});
		},
	},
);

export const commentSource = Fate.source(
	CommentView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const pano = yield* Pano;
			const sandboxViewer = yield* currentSandboxViewer;
			const mutedIds = yield* currentMutedIds;
			// Contained behind a default-off flag (#2710); both arms produce the same wire
			// output, serially or in one concurrent wave.
			const flags = yield* Flags;
			const parallelStamps = yield* flags
				.getBoolean(PHOENIX_PANO_STAMP_WAVE, false)
				.pipe(provideRequestFlags);
			return yield* pano.getCommentsByIds(ids, {
				viewerId: sandboxViewer.viewerId,
				sandboxViewer,
				mutedIds,
				parallelStamps,
			});
		},
	},
);

// Tags are embedded scalars with no standalone table; `byIds` maps kinds through the
// same static label map the service uses, so `Tag` stays fetchable by kind.
export const tagSource = Fate.source(
	TagView,
	{id: "kind"},
	{
		byIds: function* (kinds) {
			return kinds.map((kind) => ({kind, label: tagLabel(kind)}));
		},
	},
);
