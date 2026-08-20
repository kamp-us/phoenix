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
	// The feed with NO filter args is the registered root list a `post.submit` `insert`
	// reaches; filtered feeds are distinct, independently-paginated connections.
	posts: list(postDataView, {orderBy: [{createdAt: "desc"}, {id: "desc"}]}),
	// The viewer's saved posts; the resolver owns the `post_bookmark` keyset (ADR 0019).
	savedPosts: list(postDataView),
	// The public landing posts (#1424); the resolver owns the recency order + sandbox mask.
	landingPosts: list(postDataView, {orderBy: [{createdAt: "desc"}, {id: "desc"}]}),
};

export const fateModule = {
	queries,
	lists,
	mutations,
	sources: [postSource, postOverlaySource, commentSource, tagSource],
	roots,
} satisfies FateModule;
