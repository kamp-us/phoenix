/**
 * The closed vocabulary of `<route>:<state>` variants a capture can actually put on screen, and the
 * mechanism each one carries.
 *
 * The list is short on purpose. `plan.ts` has always parsed a state off a surface token, but
 * parsing one is not rendering one: a state with no mechanism captures the default pixels under a
 * variant's file name, which is coverage claimed and not held — the exact defect this vocabulary
 * was filed about. So a state enters this list only once something here makes the page render
 * differently, and every other token stays refused as reserved grammar.
 *
 * Every realized state today is a seeded session, and **the state names the audience it renders
 * as**: a surface whose whole point is that it renders below yazar — a çaylak nudge, a
 * pre-promotion prompt — cannot be judged from a yazar's pixels, and the shot comes back clean
 * showing the state the PR did not add. Tier is one axis of that audience and a verified email is
 * another, because a çaylak whose address is unverified is refused a write a verified one is
 * granted. Each identity is provisioned direct against the database by `preview-seed test-account`,
 * never by a worker route, and each shot proves the audience it actually rendered as before it is
 * recorded.
 *
 * `auth` keeps naming the top-tier identity it named when it shipped, so every invocation already
 * written against it still means what it said.
 */
import {parseSurfaceSpec} from "./plan.ts";

/**
 * The authorship tiers a capture identity can render at — `preview-seed`'s `PREVIEW_TIERS`, which
 * is the `user.tier` enum. Spelled as the stored values because the session probe compares against
 * what the preview's own session read returns.
 */
export const CAPTURE_TIERS = ["yazar", "çaylak"] as const;
export type CaptureTier = (typeof CAPTURE_TIERS)[number];

/** The audience one seeded identity renders as, both halves read back off the session probe. */
export interface CaptureAudience {
	readonly tier: CaptureTier;
	readonly emailVerified: boolean;
}

/**
 * The seeded identities — `preview-seed`'s `PREVIEW_IDENTITIES`, keyed the same way — and the
 * audience each renders as. The two lists move together.
 */
export const CAPTURE_IDENTITIES = {
	yazar: {tier: "yazar", emailVerified: true},
	çaylak: {tier: "çaylak", emailVerified: true},
	"çaylak-unverified": {tier: "çaylak", emailVerified: false},
} as const satisfies Readonly<Record<string, CaptureAudience>>;
export type CaptureIdentity = keyof typeof CAPTURE_IDENTITIES;

/**
 * Each realized state and the identity it renders as. The state token is ASCII while the identity
 * it names is not: a `--surface` operand is typed at a shell by hand, and `çaylak` on the operand
 * would make the fence depend on the caller's keyboard.
 */
export const STATE_IDENTITIES = {
	auth: "yazar",
	"auth-caylak": "çaylak",
	"auth-caylak-unverified": "çaylak-unverified",
} as const satisfies Readonly<Record<string, CaptureIdentity>>;

export const REALIZED_STATES = Object.keys(STATE_IDENTITIES) as ReadonlyArray<RealizedState>;
export type RealizedState = keyof typeof STATE_IDENTITIES;

export const isRealizedState = (state: string): state is RealizedState =>
	Object.hasOwn(STATE_IDENTITIES, state);

/**
 * The identity a state renders as, or `null` when the state names no seeded identity — the default
 * (anonymous, visitor) render, or a token outside the vocabulary, which the caller refuses before
 * anything is shot.
 */
export const identityOf = (state: string | null): CaptureIdentity | null =>
	state !== null && isRealizedState(state) ? STATE_IDENTITIES[state] : null;

/**
 * Whether a state's mechanism is a seeded session, so its shot owes a proof the session took and
 * came back as the named audience. A future state realized some other way owes a different proof,
 * not this one.
 */
export const provesSession = (state: string | null): boolean => identityOf(state) !== null;

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

/**
 * The route a surface token names, through the one parser for the same reason {@link stateOf} is.
 * A token the grammar rejects is answered whole, so the refusal a caller reads stays
 * `buildCapturePlan`'s rather than a thrown defect from a route read taken ahead of it.
 */
export const routeOf = (surface: string): string => {
	try {
		return parseSurfaceSpec(surface).route;
	} catch {
		return surface;
	}
};
