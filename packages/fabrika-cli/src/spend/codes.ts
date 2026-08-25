/**
 * The one exit table every `spend` verb allocates from, so a code means one thing across the group.
 *
 * `spend read` and `spend rollup` already drew the same distinctions — an input that is not there, an
 * input that could not be read, an input read in full that carries nothing — they just spelled them
 * as seven per-verb constants on two overlapping number lines (#5294). The names below are the
 * group's, so a caller reading `$?` gets the fact without first asking which verb produced it; the
 * stderr line still names the transcript or the ledger.
 *
 * The two shared seats are **imported from the base, never re-typed** — the discipline
 * `../exit-code-alignment.ts` can check. `12` and up are this group's own.
 *
 * **A measurement that could not be made never resolves to a plausible zero**, which is why the
 * three zero-shaped states stay three codes: {@link INPUT_ABSENT} is a proven absence,
 * {@link INPUT_UNREADABLE} is UNKNOWN, and {@link NOTHING_MEASURED} is a read that succeeded and
 * found nothing billed. Collapsing any pair would hand a caller a total it cannot trust.
 *
 * `0`, `1` and `127` are reserved by the interface convention (`../verb.ts`). No code here varies
 * with the size of a spend — epic #4779's no-gate ruling.
 */

import {
	NO_TARGET as SHARED_NO_TARGET,
	PRECONDITION_UNKNOWN as SHARED_PRECONDITION_UNKNOWN,
} from "../exit-codes.ts";

/**
 * The input this verb measures is not there: no transcript at `--transcript`, no ledger at
 * `--ledger`. A proven absence — nothing has been recorded yet.
 *
 * The base's target seat, and the same fact: the thing the verb was pointed at does not exist.
 */
export const INPUT_ABSENT = SHARED_NO_TARGET;

/**
 * The input could not be read, or its absence could not be established. UNKNOWN, never zero.
 *
 * The base's precondition seat, for the base's own reason: the read is what makes
 * {@link INPUT_ABSENT} and {@link NOTHING_MEASURED} *proven*, so a failed read can be neither.
 */
export const INPUT_UNREADABLE = SHARED_PRECONDITION_UNKNOWN;

/**
 * The input was read in full and carries nothing to measure: zero billed assistant turns, or zero
 * ledger rows. A well-formed zero, not a measured spend.
 */
export const NOTHING_MEASURED = 12;

/**
 * The ledger holds rows; this window selects none of them. `spend rollup` only.
 *
 * Its own seat rather than {@link NOTHING_MEASURED} because the caller's remedy differs — the data
 * is there and the bounds are what excluded it.
 */
export const WINDOW_SELECTED_NO_ROWS = 13;
