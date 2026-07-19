/**
 * Pano fate sources — `Post` / `Comment` / `Tag` Effect-backed loaders. fate is
 * pure transport (ADR 0016): every handler delegates to a `Pano` method.
 * `byId`/`byIds` are the only capabilities (connections come from custom
 * resolvers, ADR 0019). Reads are silent (absence = `null`/fewer rows) and
 * `E = never` — infra failures die inside the domain service (the boundary rule
 * in `.patterns/feature-services.md`). See `.patterns/fate-effect-sources.md`.
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

/**
 * The per-viewer overlay source (#2322, epic #2316 leg B): given the base feed's post
 * ids, return each viewer's own `myVote`/`isSaved`. Session-gated by construction — it
 * reads `CurrentUser` off the authed `POST /fate` edge (ADR 0169 untouched: nothing
 * session-derived rides the cacheable base). An anonymous viewer gets `null` scalars
 * for every id (the read-path convention).
 */
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
			// The read-path collapse is contained behind its default-off flag (#2710): off ⇒
			// the stamps run serially (today), on ⇒ one concurrent wave. Same wire output.
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

// Tags are embedded scalars (no standalone table); `byIds` maps kinds to
// `{kind, label}` via the same static label map the service uses, so `Tag` is
// fetchable by kind for relation callers. `Post.tags` rides the parent row.
export const tagSource = Fate.source(
	TagView,
	{id: "kind"},
	{
		byIds: function* (kinds) {
			return kinds.map((kind) => ({kind, label: tagLabel(kind)}));
		},
	},
);
