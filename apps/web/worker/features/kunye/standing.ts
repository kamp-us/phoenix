/**
 * The earned-authorship ladder and its rank vocabulary — the names the rest of
 * künye and the `Authorship` capability (#1235) share. Kept pure (no service, no
 * Effect) so the ladder ordering and the stored-tier value-set are unit-testable
 * in isolation.
 *
 * Since #1203 the authorship tier is a **server-managed `user.tier` column** read
 * through pasaport (not derived from karma), so `Kunye.tierOf` reads {@link Tier}
 * off the stored {@link StoredTier} (visitor = the no-account case). The karma→tier
 * math below (`tierForKarma`/`KARMA_THRESHOLDS`) no longer feeds `tierOf`; it is
 * kept as the future promotion/karma surface's input — see its docstring.
 */
import {Scale} from "@kampus/authz";

/** A rank on the earned-authorship ladder, lowest-first. */
export type Tier = "visitor" | "çaylak" | "yazar";

/**
 * The two **stored** account-level authorship tiers — the value-set of the
 * server-managed `user.tier` column (#1203). `visitor` is deliberately absent: it
 * is never stored, only the read-time rank of a no-account / `Unauthenticated`
 * principal. An authenticated account is therefore always `≥ çaylak`. This is the
 * "make invalid states unrepresentable" split — the column cannot hold `visitor`.
 */
export const STORED_TIERS = ["çaylak", "yazar"] as const;
export type StoredTier = (typeof STORED_TIERS)[number];

/**
 * The `visitor < çaylak < yazar` ladder (ADR 0107 §4) — the canonical kamp.us
 * `Scale` the `Authorship` `Capability.Level` instances (#1235) floor against
 * (`AddEntry` = çaylak, `OpenTerm` = yazar).
 */
export const authorshipLadder = Scale(["visitor", "çaylak", "yazar"]);

/**
 * Provisional earned-ladder boundaries: the minimum `total_karma` for each rank.
 *
 * **Ownership (since #1203):** these no longer derive the live tier — `Kunye.tierOf`
 * reads the stored `user.tier` column. The karma→tier math survives as the input the
 * karma-triggered **promotion** path (#1206) uses to decide *when* to flip the stored
 * column, and the **karma surface** (#1208) refines the real thresholds. Kept here so
 * that math lives in one pure, testable place rather than being re-derived later.
 */
export const KARMA_THRESHOLDS = {çaylak: 1, yazar: 100} as const;

/** Map earned karma onto the ladder rank — the promotion (#1206) / karma (#1208) input. */
export const tierForKarma = (karma: number): Tier =>
	karma >= KARMA_THRESHOLDS.yazar
		? "yazar"
		: karma >= KARMA_THRESHOLDS.çaylak
			? "çaylak"
			: "visitor";

/**
 * The **reduced** karma bar a vouched çaylak must clear for a yazar's vouch to
 * promote them to yazar (#1206 — the author-vouch tandem). Deliberately far below
 * the unassisted `KARMA_THRESHOLDS.yazar` bar: a yazar putting their standing
 * behind a çaylak buys down the karma cost, so the tandem (vouch + this reduced
 * bar) is an easier path than grinding karma alone. The vouch is required — this
 * bar never auto-promotes on its own (no karma-AUTO-promotion; North Star #1194).
 *
 * Provisional product-tunable (D4, epic #1202) — #1289 pins it at the confirmed
 * `≈15 net` (was `10` in #1206). A named constant, not a magic number inline at the
 * check site; the order-independent tandem resolver (#1289) reads it from here.
 */
export const VOUCH_PROMOTION_KARMA_BAR = 15 as const;

/**
 * The karma bar a çaylak must clear to reach yazar, given whether they hold an
 * active vouch. A vouched çaylak clears the reduced tandem bar
 * ({@link VOUCH_PROMOTION_KARMA_BAR}); an unvouched one faces the full unassisted
 * `KARMA_THRESHOLDS.yazar`. Pure so the "which bar applies" rule is the single
 * testable source the çaylak-self standing read (#1316) reads — the frontend never
 * hardcodes a bar, because *which* bar is live depends on vouch-exists.
 */
export const promotionBarFor = (vouchExists: boolean): number =>
	vouchExists ? VOUCH_PROMOTION_KARMA_BAR : KARMA_THRESHOLDS.yazar;

/**
 * The **concurrent-vouch cap** (D5, epic #1202 / #1289): the maximum number of
 * *active* vouches a single yazar may hold at once. A vouch is "spent" while its
 * çaylak is still pending (the row exists and the candidate is still çaylak) and
 * "returns" a slot on promotion (the candidate becomes yazar) or on withdrawal (the
 * row is deleted). A yazar already holding this many active vouches is denied a
 * further one until a slot frees — so a yazar's stake is rationed and a single
 * actor can't blanket-vouch the whole roster.
 *
 * Provisional product-tunable, pinned in code (not a magic number) like
 * {@link VOUCH_PROMOTION_KARMA_BAR}.
 */
export const VOUCH_CONCURRENT_CAP = 3 as const;
