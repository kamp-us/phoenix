/**
 * The closed vocabulary of `<route>:<state>` variants a capture can actually put on screen, and the
 * mechanism each one carries (#7051, #7398).
 *
 * The list is short on purpose. `plan.ts` has always parsed a state off a surface token, but
 * parsing one is not rendering one: a state with no mechanism captures the default pixels under a
 * variant's file name, which is coverage claimed and not held — the exact defect this vocabulary
 * was filed about. So a state enters this list only once something here makes the page render
 * differently, and every other token stays refused as reserved grammar.
 *
 * Every realized state today is a seeded session, and **the state names the tier it renders at**,
 * because a tier is an audience: a surface whose whole point is that it renders below yazar — a
 * çaylak nudge, a pre-promotion prompt — cannot be judged from a yazar's pixels, and the shot comes
 * back clean showing the state the PR did not add (#7398). Each identity is provisioned direct-D1
 * by `preview-seed test-account`, never by a worker route, and each shot proves the tier it
 * actually rendered at before it is recorded.
 *
 * `auth` keeps naming the yazar+moderator identity #7051 shipped, so every invocation written
 * against that ticket still means what it said.
 */
import {parseSurfaceSpec} from "./plan.ts";

/**
 * The authorship tiers a capture identity can render at — `preview-seed`'s `PREVIEW_TIERS`, which
 * is the `user.tier` enum. Spelled as the stored values because the session probe compares against
 * what the preview's own session read returns.
 */
export const CAPTURE_TIERS = ["yazar", "çaylak"] as const;
export type CaptureTier = (typeof CAPTURE_TIERS)[number];

/**
 * Each realized state and the tier its identity renders at. The state token is ASCII while the tier
 * it names is not: a `--surface` operand is typed at a shell by hand, and `çaylak` on the operand
 * would make the fence depend on the caller's keyboard.
 */
export const STATE_TIERS = {
	auth: "yazar",
	"auth-caylak": "çaylak",
} as const satisfies Readonly<Record<string, CaptureTier>>;

export const REALIZED_STATES = Object.keys(STATE_TIERS) as ReadonlyArray<RealizedState>;
export type RealizedState = keyof typeof STATE_TIERS;

export const isRealizedState = (state: string): state is RealizedState =>
	Object.hasOwn(STATE_TIERS, state);

/**
 * The tier a state renders at, or `null` when the state names no seeded identity — the default
 * (anonymous, visitor) render, or a token outside the vocabulary, which the caller refuses before
 * anything is shot.
 */
export const tierOf = (state: string | null): CaptureTier | null =>
	state !== null && isRealizedState(state) ? STATE_TIERS[state] : null;

/**
 * Whether a state's mechanism is a seeded session, so its shot owes a proof the session took and
 * came back at the named tier. A future state realized some other way owes a different proof, not
 * this one.
 */
export const provesSession = (state: string | null): boolean => tierOf(state) !== null;

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
