/**
 * The ambient çaylak meter's derivation (#7045, epic #4304) — what the topbar karma chip
 * becomes for a signed-in çaylak, off the SAME aggregate-only `myAuthorshipStanding`
 * selection `CaylakStatusBlock` already reads (`STANDING_FIELDS`).
 *
 * The honesty rule is inherited from `caylakPromotionPath`, never re-derived: an unvouched
 * çaylak gets the karma delta but NO promotion bar, because `resolveTandem` short-circuits on
 * the vouch half and no amount of karma promotes them (#1323).
 */
import {VOUCH_PROMOTION_KARMA_BAR} from "../../../worker/features/kunye/standing";
import {
	caylakPromotionPath,
	VOUCH_NEEDED_COPY,
	vouchExistsLabel,
} from "../profile/CaylakStatusBlock";

/** The three aggregate scalars the chip reads — a subset of `STANDING_FIELDS`, never a widening. */
export interface CaylakMeterStanding {
	readonly karma: number;
	readonly bar: number;
	readonly vouchExists: boolean;
}

/**
 * The chip's shape. The bar's presence is carried by the variant rather than a boolean beside
 * the copy, so "unvouched with a promotion bar" — the state #1323 forbids — is unrepresentable.
 *
 * `target` is the number the delta reads against, and each variant derives its own, because the
 * wire's `bar` carries two different meanings: `promotionBarFor` sends the reduced bar to a
 * vouched çaylak and the unassisted `KARMA_THRESHOLDS.yazar` to an unvouched one.
 */
export type CaylakMeter =
	| {
			readonly kind: "karma-bar";
			readonly karma: number;
			readonly target: number;
			readonly vouchFact: string;
	  }
	| {
			readonly kind: "vouch-needed";
			readonly karma: number;
			readonly target: number;
			readonly vouchFact: string;
			/** `CaylakStatusBlock`'s settled copy, rendered as visible chip text — never a tooltip. */
			readonly vouchNeeded: string;
	  };

/** `kefil: var` / `kefil: yok` — the next unmet condition named beside the karma delta. */
export function vouchFactLabel(vouchExists: boolean): string {
	return `kefil: ${vouchExistsLabel(vouchExists)}`;
}

export function caylakMeter(standing: CaylakMeterStanding): CaylakMeter {
	const path = caylakPromotionPath(standing.vouchExists);
	const shared = {
		karma: standing.karma,
		vouchFact: vouchFactLabel(standing.vouchExists),
	} as const;
	// Vouched reads the wire's own bar and never re-derives it (#1316). Unvouched cannot: the
	// wire's 100 is the goal #1323 calls unlivable, so the chip names the reduced bar the kefil
	// buys down to, read from the module that owns it so the two can never drift apart.
	return path.kind === "karma-bar"
		? {kind: "karma-bar", ...shared, target: standing.bar}
		: {
				kind: "vouch-needed",
				...shared,
				target: VOUCH_PROMOTION_KARMA_BAR,
				vouchNeeded: VOUCH_NEEDED_COPY.message,
			};
}
