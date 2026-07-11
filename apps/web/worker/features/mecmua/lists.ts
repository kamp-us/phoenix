/**
 * mecmua root list resolvers (#2500, epic #2467). `mecmuaFeed` is the subscribed-author
 * time feed: a `CurrentUser`-scoped connection of PUBLISHED `MecmuaPostView` edges from
 * the reader's subscribed authors, ordered `publishedAt desc` (newest-first). Per ADR
 * 0019 the service owns the keyset + cursor (`Mecmua.listFeedConnection`); this layer
 * only reshapes the page into a `ConnectionResult`, mirroring pano's `savedPosts`
 * (per-viewer, signed-out → empty). See `.patterns/fate-connections.md`.
 *
 * Dark behind the default-off `MECMUA_FEED` flag (ADR 0083): with it off the resolver
 * serves an empty connection, so the whole feed surface ships dark until a human flips
 * the flag at release — the same containment the mecmua write/read paths use.
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

/** Stamp the wire `__typename` onto a feed row — the one feed-read shaper. */
const toMecmuaPost = (r: MecmuaPostRow): MecmuaPost => ({__typename: "MecmuaPost", ...r});

const feedConnection = (page: MecmuaFeedPage) =>
	toConnection<MecmuaPostRow, MecmuaPost>(
		page,
		(row) => row.id,
		(row) => toMecmuaPost(row),
	);

/** Is the mecmua feed on for this request? Safe-default `false` (ships dark). */
const feedOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(MECMUA_FEED, false).pipe(provideRequestFlags);
});

/** Is the mecmua write path on for this request? Safe-default `false` (ships dark). */
const writeOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(MECMUA_WRITE, false).pipe(provideRequestFlags);
});

export const lists = {
	mecmuaFeed: Fate.list(
		{args: MecmuaFeedArgs, type: MecmuaPostView},
		Effect.fn("mecmuaFeed")(function* ({args}) {
			// Flag off OR signed-out ⇒ empty feed: the surface is dark until release, and an
			// anonymous reader subscribes to no one, so there is nothing to serve either way.
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
	// The author's OWN posts — drafts + published (#2544), the private retrieval surface
	// for the write path. Scoped to `CurrentUser`, so it never exposes another author's
	// drafts; gated behind the same `MECMUA_WRITE` seam as the editor, so it ships dark.
	mecmuaMyPosts: Fate.list(
		{args: MecmuaFeedArgs, type: MecmuaPostView},
		Effect.fn("mecmuaMyPosts")(function* ({args}) {
			// Flag off OR signed-out ⇒ empty: the write surface is dark until release, and an
			// anonymous reader authored nothing, so there is nothing of theirs to serve.
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
