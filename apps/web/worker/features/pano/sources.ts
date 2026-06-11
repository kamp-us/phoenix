/**
 * Pano fate sources — `Post` / `Comment` / `Tag` Effect-backed loaders.
 *
 * fate is pure transport (ADR 0016): it never queries D1. Every handler
 * delegates to a `Pano` method, so all read logic stays in the domain layer.
 * `byId`/`byIds` are the only capabilities implemented — the relation
 * workhorse (avoids the N+1) that also backs live relation masking;
 * connections come from custom resolvers (ADR 0019).
 *
 * The loader contract is in the types (`.patterns/fate-effect-sources.md`):
 * reads are silent (absence = `null`/fewer rows), `E = never` — infra
 * failures are defects, died inside the domain service (the boundary rule in
 * `.patterns/feature-services.md`), so they never become wire values.
 */
import {CurrentUser, Fate} from "@phoenix/fate-effect";
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

/**
 * Tags are embedded scalars on the post row (no standalone table). The `byIds`
 * handler maps tag kinds to `{kind, label}` via the same static label map the
 * service uses, so the `Tag` type is fetchable by kind for relation callers;
 * `Post.tags` itself rides the pre-built array on the parent row.
 */
export const tagSource = Fate.source(
	TagView,
	{id: "kind"},
	{
		byIds: function* (kinds) {
			return kinds.map((kind) => ({kind, label: tagLabel(kind)}));
		},
	},
);
