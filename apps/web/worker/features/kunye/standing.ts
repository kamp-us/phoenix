/**
 * The earned-authorship ladder and its pure karma→tier derivation — the rank
 * vocabulary the rest of künye and the `Authorship` capability (#1235) share.
 * Kept pure (no service, no Effect) so the ladder ordering and the threshold
 * boundaries are unit-testable in isolation.
 */
import {Scale} from "@kampus/authz";

/** A rank on the earned-authorship ladder, lowest-first. */
export type Tier = "visitor" | "çaylak" | "yazar";

/**
 * The `visitor < çaylak < yazar` ladder (ADR 0107 §4) — the canonical kamp.us
 * `Scale` the `Authorship` `Capability.Level` instances (#1235) floor against
 * (`AddEntry` = çaylak, `OpenTerm` = yazar).
 */
export const authorshipLadder = Scale(["visitor", "çaylak", "yazar"]);

/**
 * Provisional earned-ladder boundaries: the minimum `total_karma` for each rank.
 * The real values are a product decision owned by #1203/#1235 (the authorship
 * tier model), which supersedes this karma derivation when the tier becomes a
 * server-managed column read through pasaport. These defaults keep every rank
 * reachable so the standing read is testable.
 */
export const KARMA_THRESHOLDS = {çaylak: 1, yazar: 100} as const;

/** Map earned karma onto the ladder rank. */
export const tierForKarma = (karma: number): Tier =>
	karma >= KARMA_THRESHOLDS.yazar
		? "yazar"
		: karma >= KARMA_THRESHOLDS.çaylak
			? "çaylak"
			: "visitor";
