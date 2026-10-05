/**
 * `baseRedLaps` — how many free laps one epic child's task gets on a broken assembly base before its
 * lane parks.
 *
 * A red base is `lane integrate` exit `75`: the validator that failed over the merged tree failed over
 * the pre-merge head too, so the child is not charged a repair try for it and the lap is free. A
 * broken base is rarely a fluke, though, so a free lap mostly fails again, and the machinery lap
 * budget alone would let one task run every check twice per lap until all its laps were gone. Past
 * this many red-base laps since the task's last `UNBLOCKED` or `DONE`, `lane report` lands the park
 * on the same cause instead of the lap, and the lane waits for someone to fix the base.
 *
 * Read by `lane report` alone, off the repository that OWNS the cwd, as `parkCause` is.
 *
 * **The shipped default is `2`.** A declared value is a non-negative integer. `0` is writable and
 * means every red base parks at once. A fraction or a numeric string refuses at load rather than
 * round to a number the writer did not mean.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10257#issuecomment-5983173740
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const BASE_RED_LAPS = "baseRedLaps";

/** The free red-base laps a task gets when the repo declares none. */
export const SHIPPED_BASE_RED_LAPS = 2;

const decode = (raw: unknown): Decoded<number> =>
	typeof raw === "number" && Number.isInteger(raw) && raw >= 0
		? {_tag: "Value", value: raw}
		: {
				_tag: "Malformed",
				reason: `\`${BASE_RED_LAPS}\` is not a non-negative integer — write how many free laps a broken assembly base gets per task before the lane parks`,
			};

export const baseRedLapsKey: KeyGroup<number> = {
	key: BASE_RED_LAPS,
	shippedDefault: SHIPPED_BASE_RED_LAPS,
	decode,
	jsonSchema: {
		type: "integer",
		description:
			"How many free laps one epic child's task gets when `lane integrate` proves the assembly base was already red (exit 75), counted since the task's last UNBLOCKED or DONE. Past it, `lane report` records the `assembly-base-red` park instead of the lap. Shipped default 2; 0 parks every red base at once.",
		minimum: 0,
	},
};
