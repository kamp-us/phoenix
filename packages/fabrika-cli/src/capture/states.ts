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
 * cookie (`auth.ts`), so the surface renders as a signed-in yazar+moderator instead of a visitor.
 * The account is provisioned direct-D1 by `preview-seed test-account`, never by a worker route.
 */

export const REALIZED_STATES = ["auth"] as const;
export type RealizedState = (typeof REALIZED_STATES)[number];

export const isRealizedState = (state: string): state is RealizedState =>
	(REALIZED_STATES as readonly string[]).includes(state);

/** The state a surface token names, or `null` for the default (anonymous, visitor) render. */
export const stateOf = (surface: string): string | null => {
	const colon = surface.indexOf(":");
	if (colon === -1) return null;
	const state = surface.slice(colon + 1);
	return state.length === 0 ? null : state;
};
