/**
 * Which sandbox badge one item shows this viewer (#6427, epic #4306) — a pure function of
 * the two wire fields and ownership, extracted DOM-free (the `caylakVisibilityGating` idiom)
 * so the rule is pinned without a render.
 *
 * The two badges are siblings with disjoint audiences: `sandboxed` (#2200) is owner-scoped —
 * the AUTHOR's own "incelemede" state — while `sandboxedInPlace` (#6425) marks SOMEBODY
 * ELSE's hazırlık-stage work for the opted-in reader of #6423. Server-side they are true for
 * disjoint viewers on almost every row, but not on all: a çaylak promoted to yazar who opts
 * in still has their own not-yet-promoted rows, and reads both fields true on them.
 *
 * **The ruling: at most one badge, and on your own item the owner's badge wins.** Stacking
 * "incelemede" beside "çaylak katkısı" would say the same thing twice in two voices, and the
 * reader-facing marker is the wrong voice for your own work — you are not a reader being told
 * whose post this is. So ownership is checked first and the çaylak marker is suppressed on an
 * item you wrote.
 *
 * A surface that does not carry `sandboxed` at all (the pano feed row never selected it)
 * passes it `undefined` and simply lands on `none` for the owner — the same nothing it
 * renders today.
 */
export type SandboxMarkerKind = "review" | "caylak" | "none";

export interface SandboxMarkerInput {
	/** The viewer authored this item. */
	readonly isOwn: boolean;
	/** Owner-scoped in-review flag (#2200); absent on surfaces that never selected it. */
	readonly sandboxed?: boolean | null | undefined;
	/**
	 * The reader-facing çaylak marker (#6425). Server-derived and structurally false while
	 * `PHOENIX_CAYLAK_VISIBILITY` is off, so the flag needs no second client-side read here —
	 * a client gate could only disagree with the server that already decided.
	 */
	readonly sandboxedInPlace?: boolean | null | undefined;
}

export function sandboxMarker(input: SandboxMarkerInput): SandboxMarkerKind {
	if (input.isOwn) return input.sandboxed === true ? "review" : "none";
	return input.sandboxedInPlace === true ? "caylak" : "none";
}
