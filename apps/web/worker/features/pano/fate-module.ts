/** pano's contribution to the one fate config. See `../fate/module.ts`. */
import {list} from "@nkzw/fate/server";
import type {FateModule, FateRootsRecord} from "../fate/module.ts";
import {lists} from "./lists.ts";
import {mutations} from "./mutations.ts";
import {queries} from "./queries.ts";
import {commentSource, postSource, tagSource} from "./sources.ts";
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
};

export const fateModule = {
	queries,
	lists,
	mutations,
	sources: [postSource, commentSource, tagSource],
	roots,
} satisfies FateModule;
