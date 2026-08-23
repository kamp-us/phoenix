/**
 * `divan.pendingCount` — the topbar badge's read (#6760): a synthetic singleton
 * carrying how many sandbox-backlog items await divan review. It sits behind the SAME
 * disjunctive {@link requireDivanAccess} gate `divan.roster`/`divan.backlog` enforce,
 * so a çaylak or visitor is denied at the wire exactly as they are there — the badge
 * never widens who can read the divan, it only gives its existing audience a reason to
 * open it. No flag, no `/fate/live` topic: a plain one-shot query.
 */
import {Fate} from "@kampus/fate-effect";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {Denied} from "../kunye/errors.ts";
import {Divan} from "./Divan.ts";
import {requireDivanAccess, ViewDivan} from "./gate.ts";

/** The `bildirim.unreadCount` singleton idiom (`UNREAD_SINGLETON_ID`). */
export const PENDING_SINGLETON_ID = "pending";

// The handler stamps `__typename` itself: an inline-resolved entity has no source that
// would stamp it (the same call `lists.ts` makes for its two views).
const pendingGated = Effect.fn("divan.pendingGated")(function* () {
	yield* ViewDivan;
	const divan = yield* Divan;
	const count = yield* divan.pendingTotal();
	return {__typename: "DivanPending" as const, id: PENDING_SINGLETON_ID, count};
});

export const queries = {
	"divan.pendingCount": Fate.query(
		{type: "DivanPending", error: Schema.Union([Denied])},
		Effect.fn("divan.pendingCount")(function* () {
			return yield* requireDivanAccess(pendingGated());
		}),
	),
};
