/**
 * Pano fate sources — `Post` / `Comment` / `Tag` Effect-backed loaders. fate is
 * pure transport (ADR 0016): every handler delegates to a `Pano` method.
 * `byId`/`byIds` are the only capabilities (connections come from custom
 * resolvers, ADR 0019). Reads are silent (absence = `null`/fewer rows) and
 * `E = never` — infra failures die inside the domain service (the boundary rule
 * in `.patterns/feature-services.md`). See `.patterns/fate-effect-sources.md`.
 */
import {Fate} from "@kampus/fate-effect";
import {currentSandboxViewer} from "../kunye/sandbox.ts";
import {Pano, tagLabel} from "./Pano.ts";
import {CommentView, PostView, TagView} from "./views.ts";

export const postSource = Fate.source(
	PostView,
	{id: "id"},
	{
		byIds: function* (ids) {
			const pano = yield* Pano;
			const sandboxViewer = yield* currentSandboxViewer;
			return yield* pano.getPostsByIds(ids, {viewerId: sandboxViewer.viewerId, sandboxViewer});
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
			return yield* pano.getCommentsByIds(ids, {viewerId: sandboxViewer.viewerId, sandboxViewer});
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
