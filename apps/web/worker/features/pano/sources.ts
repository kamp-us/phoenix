/**
 * Pano fate sources — `Post` / `Comment` / `Tag` Effect-backed loaders. fate is
 * pure transport (ADR 0016): every handler delegates to a `Pano` method.
 * `byId`/`byIds` are the only capabilities (connections come from custom
 * resolvers, ADR 0019). Reads are silent (absence = `null`/fewer rows) and
 * `E = never` — infra failures die inside the domain service (the boundary rule
 * in `.patterns/feature-services.md`). See `.patterns/fate-effect-sources.md`.
 */
import {CurrentUser, Fate} from "@kampus/fate-effect";
import {Pano, tagLabel} from "./Pano.ts";
import {CommentView, PostView, TagView} from "./views.ts";

export const postSource = Fate.source(
	PostView,
	{id: "id"},
	{
		byId: function* (id) {
			const pano = yield* Pano;
			const {user} = yield* CurrentUser;
			const rows = yield* pano.getPostsByIds([id], {viewerId: user?.id ?? null});
			return rows[0] ?? null;
		},
		byIds: function* (ids) {
			const pano = yield* Pano;
			const {user} = yield* CurrentUser;
			return yield* pano.getPostsByIds(ids, {viewerId: user?.id ?? null});
		},
	},
);

export const commentSource = Fate.source(
	CommentView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const pano = yield* Pano;
			const {user} = yield* CurrentUser;
			return yield* pano.getCommentsByIds(ids, {viewerId: user?.id ?? null});
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
