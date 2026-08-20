/**
 * mecmua root list resolvers. `mecmuaFeed` is the subscribed-author time feed: a
 * `CurrentUser`-scoped connection of PUBLISHED posts, newest-first. Per ADR 0019 the service
 * owns the keyset + cursor; this layer only reshapes the page (.patterns/fate-connections.md).
 *
 * Dark behind the default-off `MECMUA_FEED` flag (ADR 0083): off ⇒ an empty connection.
 */
import {CurrentUser, Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {MECMUA_FEED, MECMUA_WRITE} from "../../../src/flags/keys.ts";
import {emptyKeysetPage} from "../../db/keyset.ts";
import {toConnection} from "../fate/connection.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Mecmua, type MecmuaFeedPage} from "./Mecmua.ts";
import type {MecmuaPostRow} from "./post-fields.ts";
import type {MecmuaPost} from "./views.ts";
import {MecmuaPostView} from "./views.ts";

const MecmuaFeedArgs = Schema.Struct({
	first: Schema.optional(Schema.Number),
	after: Schema.optional(Schema.String),
});

const toMecmuaPost = (r: MecmuaPostRow): MecmuaPost => ({__typename: "MecmuaPost", ...r});

const feedConnection = (page: MecmuaFeedPage) =>
	toConnection<MecmuaPostRow, MecmuaPost>(
		page,
		(row) => row.id,
		(row) => toMecmuaPost(row),
	);

const feedOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(MECMUA_FEED, false).pipe(provideRequestFlags);
});

const writeOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(MECMUA_WRITE, false).pipe(provideRequestFlags);
});

export const lists = {
	mecmuaFeed: Fate.list(
		{args: MecmuaFeedArgs, type: MecmuaPostView},
		Effect.fn("mecmuaFeed")(function* ({args}) {
			// Flag off OR signed-out ⇒ empty feed: an anonymous reader subscribes to no one.
			const {user} = yield* CurrentUser;
			if (!user || !(yield* feedOn)) return feedConnection(emptyKeysetPage);

			const mecmua = yield* Mecmua;
			const page = yield* mecmua.listFeedConnection({
				subscriberId: user.id,
				...(args.first !== undefined ? {first: args.first} : {}),
				...(args.after !== undefined ? {after: args.after} : {}),
			});
			return feedConnection(page);
		}),
	),
	// The author's OWN posts, drafts included — scoped to `CurrentUser`, so it never exposes
	// another author's drafts; gated behind the same `MECMUA_WRITE` seam as the editor.
	mecmuaMyPosts: Fate.list(
		{args: MecmuaFeedArgs, type: MecmuaPostView},
		Effect.fn("mecmuaMyPosts")(function* ({args}) {
			// Flag off OR signed-out ⇒ empty: an anonymous reader authored nothing.
			const {user} = yield* CurrentUser;
			if (!user || !(yield* writeOn)) return feedConnection(emptyKeysetPage);

			const mecmua = yield* Mecmua;
			const page = yield* mecmua.listOwnPostsConnection({
				authorId: user.id,
				...(args.first !== undefined ? {first: args.first} : {}),
				...(args.after !== undefined ? {after: args.after} : {}),
			});
			return feedConnection(page);
		}),
	),
};
