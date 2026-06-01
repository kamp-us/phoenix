/**
 * Pano fate source executors — `Post` / `Comment` / `Tag` Effect-backed reads.
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
import {type CommentRow, Pano, type PostSummaryRow, type PostTagRow, tagLabel} from "./Pano.ts";
import {commentDataView, postDataView, tagDataView} from "./views.ts";

type PostViewRow = {[K in keyof PostSummaryRow]: PostSummaryRow[K]};
type CommentViewRow = {[K in keyof CommentRow]: CommentRow[K]};
type TagViewRow = {[K in keyof PostTagRow]: PostTagRow[K]};

export const postExecutor: SourceExecutor = fateSource<PostViewRow>({
	byId: function* (id) {
		const pano = yield* Pano;
		const auth = yield* Auth;
		const rows = yield* pano.getPostsByIds([id], {viewerId: auth.user?.id ?? null});
		return rows[0] ?? null;
	},
	byIds: function* (ids) {
		const pano = yield* Pano;
		const auth = yield* Auth;
		return yield* pano.getPostsByIds(ids, {viewerId: auth.user?.id ?? null});
	},
});

export const commentExecutor: SourceExecutor = fateSource<CommentViewRow>({
	byIds: function* (ids) {
		const pano = yield* Pano;
		const auth = yield* Auth;
		return yield* pano.getCommentsByIds(ids, {viewerId: auth.user?.id ?? null});
	},
});

// Tags are embedded scalars on the post row (no standalone table). The `byIds`
// executor maps tag kinds to `{kind, label}` via the same static label map the
// service uses, so the `Tag` type is fetchable by kind for relation callers;
// `Post.tags` itself rides the pre-built array on the parent row.
export const tagExecutor: SourceExecutor = fateSource<TagViewRow>({
	byIds: function* (kinds) {
		return kinds.map((kind) => ({kind, label: tagLabel(kind)}));
	},
});

export const postSource: AnySourceDefinition = {id: "id", view: postDataView as AnyDataView};
export const commentSource: AnySourceDefinition = {id: "id", view: commentDataView as AnyDataView};
export const tagSource: AnySourceDefinition = {id: "kind", view: tagDataView as AnyDataView};
