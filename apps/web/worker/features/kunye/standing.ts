/**
 * The earned-authorship ladder and its rank vocabulary. The live tier is the
 * server-managed `user.tier` column (#1203), NOT derived from karma — the karma→tier
 * math here feeds only the promotion path, never `Kunye.tierOf`.
 */
import {Scale} from "@kampus/authz";

/** A rank on the earned-authorship ladder, lowest-first. */
export type Tier = "visitor" | "çaylak" | "yazar";

/**
 * The value-set of the `user.tier` column. `visitor` is deliberately absent — it is
 * never stored, only the read-time rank of a no-account principal, so an
 * authenticated account is always `≥ çaylak`.
 */
export const STORED_TIERS = ["çaylak", "yazar"] as const;
export type StoredTier = (typeof STORED_TIERS)[number];

/**
 * Whether content authored at this tier lands in the mod-only sandbox (#1205). Kept
 * dependency-free so the server's `sandboxedAtForAuthor` and the client's optimistic
 * node run the SAME rule — a client that guesses differently flashes the çaylak's own
 * comment as published before reconciliation (#4282).
 */
export const sandboxesNewContent = (tier: Tier | undefined): boolean => tier === "çaylak";

/** See ADR 0107 §4. */
export const authorshipLadder = Scale(["visitor", "çaylak", "yazar"]);

/**
 * Minimum `total_karma` per rank. These do NOT derive the live tier (that is the
 * stored `user.tier` column since #1203) — they only decide when the promotion path
 * flips that column.
 */
export const KARMA_THRESHOLDS = {çaylak: 1, yazar: 100} as const;

export const tierForKarma = (karma: number): Tier =>
	karma >= KARMA_THRESHOLDS.yazar
		? "yazar"
		: karma >= KARMA_THRESHOLDS.çaylak
			? "çaylak"
			: "visitor";

/**
 * The reduced karma bar a *vouched* çaylak clears to reach yazar (#1289). Deliberately
 * far below `KARMA_THRESHOLDS.yazar` — the yazar's vouch buys down the karma cost. The
 * vouch is always required; this bar never auto-promotes on its own (#1194).
 */
export const VOUCH_PROMOTION_KARMA_BAR = 15 as const;

/**
 * Which bar applies depends on vouch-exists, so the frontend must read it from here
 * rather than hardcode either constant (#1316).
 */
export const promotionBarFor = (vouchExists: boolean): number =>
	vouchExists ? VOUCH_PROMOTION_KARMA_BAR : KARMA_THRESHOLDS.yazar;

/**
 * Max *active* vouches one yazar may hold at once (#1289). A vouch is spent while its
 * çaylak is still çaylak, and returns a slot on promotion or withdrawal — so no single
 * actor can blanket-vouch the roster.
 */
export const VOUCH_CONCURRENT_CAP = 3 as const;
