/**
 * The closed vocabulary of `<route>:<state>` variants a capture can actually put on screen, and the
 * mechanism each one carries (#7051).
 *
 * The list is short on purpose. `plan.ts` has always parsed a state off a surface token, but
 * parsing one is not rendering one: a state with no mechanism captures the default pixels under a
 * variant's file name, which is coverage claimed and not held — the exact defect this ticket was
 * filed about. So a state enters this list only once something here makes the page render
 * differently, and every other token stays refused as reserved grammar.
 *
 * `auth` is the first: the capture context presents the moderator-tier test account's session
 * cookie (`auth.ts`) and proves the session took before the shot is recorded, so the surface renders
 * as a signed-in yazar+moderator instead of a visitor. The account is provisioned direct-D1 by
 * `preview-seed test-account`, never by a worker route.
 */
import {parseSurfaceSpec} from "./plan.ts";

export const REALIZED_STATES = ["auth"] as const;
export type RealizedState = (typeof REALIZED_STATES)[number];

export const isRealizedState = (state: string): state is RealizedState =>
	(REALIZED_STATES as readonly string[]).includes(state);

/**
 * Whether a state's mechanism is the seeded session, so its shot owes a proof the session took.
 * `auth` is the whole of it today; a future state realized some other way owes a different proof,
 * not this one.
 */
export const provesSession = (state: string | null): boolean => state === "auth";

/**
 * The state a surface token names, or `null` for the default (anonymous, visitor) render. Read
 * through `parseSurfaceSpec` rather than re-split here: one grammar, one parser.
 *
 * A token the grammar rejects outright (empty, or route-less) names no state — `buildCapturePlan`
 * refuses it by its own message, and answering `null` here keeps that refusal the one the caller
 * reads instead of a thrown defect from the state check that runs first.
 */
export const stateOf = (surface: string): string | null => {
	try {
		return parseSurfaceSpec(surface).state;
	} catch {
		return null;
	}
};
