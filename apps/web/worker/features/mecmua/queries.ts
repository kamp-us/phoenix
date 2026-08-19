/**
 * mecmua root query resolvers (#2527, epic #2467). A signed-out reader or the flag-off
 * state resolves `subscribed: false` rather than throwing — the toggle only renders
 * for a signed-in reader with the feed on, and the writes are gated the same way.
 *
 * Dark behind the default-off `MECMUA_FEED` flag (ADR 0083), so no subscription state
 * leaks until a human flips it at release.
 */
import {CurrentUser, Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {MECMUA_FEED} from "../../../src/flags/keys.ts";
import {UserId} from "../../lib/ids.ts";
import {Flags} from "../flagship/Flags.ts";
import {provideRequestFlags} from "../flagship/FlagsContext.ts";
import {Mecmua} from "./Mecmua.ts";
import type {MecmuaSubscriptionReceipt} from "./views.ts";
import {MecmuaSubscriptionReceiptView} from "./views.ts";

// `authorId` decodes byte-identically but arrives branded, so the receipt and the
// read below carry the brand end-to-end (#2700).
const SubscriptionStateArgs = Schema.Struct({
	authorId: UserId,
});

// Safe-default `false` — ships dark.
const feedOn = Effect.gen(function* () {
	const flags = yield* Flags;
	return yield* flags.getBoolean(MECMUA_FEED, false).pipe(provideRequestFlags);
});

const toReceipt = (authorId: UserId, subscribed: boolean): MecmuaSubscriptionReceipt => ({
	__typename: "MecmuaSubscriptionReceipt",
	id: authorId,
	subscribed,
});

export const queries = {
	mecmuaSubscription: Fate.query(
		{args: SubscriptionStateArgs, type: MecmuaSubscriptionReceiptView},
		Effect.fn("mecmuaSubscription")(function* ({args}) {
			const {user} = yield* CurrentUser;
			if (!user || !(yield* feedOn)) return toReceipt(args.authorId, false);
			const mecmua = yield* Mecmua;
			return toReceipt(
				args.authorId,
				yield* mecmua.isSubscribed(UserId.make(user.id), args.authorId),
			);
		}),
	),
};
