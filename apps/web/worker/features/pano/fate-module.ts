/** pano's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {commentSource, postOverlaySource, postSource, tagSource} from "./sources.ts";
import {postDataView} from "./views.ts";

const roots: FateRootsRecord = {
	post: postDataView,
	// The feed with no filter args is the registered root list a `post.submit`
	// `insert` reaches (filtered feeds are distinct, independently-paginated
	// connections). See `.patterns/fate-mutations-client.md`.
	posts: list(postDataView, {orderBy: [{createdAt: "desc"}, {id: "desc"}]}),
	// The viewer's saved posts; the `savedPosts` resolver owns the order (the
	// `post_bookmark` keyset, ADR 0019). Reuses `postDataView` so `isSaved`/`myVote`
	// come for free.
	savedPosts: list(postDataView),
	// The public landing posts (#1424) — live-only recent posts, batched into the
	// landing screen's one `useRequest` beside `landingStats` (ADR 0021). The
	// `landingPosts` resolver owns the recency order + the sandbox mask.
	landingPosts: list(postDataView, {orderBy: [{createdAt: "desc"}, {id: "desc"}]}),
};

export const fateModule = {
	queries,
	lists,
	mutations,
	sources: [postSource, postOverlaySource, commentSource, tagSource],
	roots,
} satisfies FateModule;
