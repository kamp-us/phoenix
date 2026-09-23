/**
 * The walk a snapshot under an older program version takes to reach the current one, and the only
 * thing that admits such a snapshot at all (the founder ruling on #8907:
 * https://github.com/kamp-us/phoenix/issues/8907#issuecomment-5625300780). An added field is not
 * worth a boot: #8876 grew `DeskState` by one boolean, the desk refused every checkpoint written
 * before it, and the recovery was one hand edit of `.tuval/shell.json`.
 *
 * What the ruling did not move is the refusal itself. A version this walk cannot reach the current
 * one from is refused exactly as it was (#7467, #7514) — the process stays absent until a person
 * decides, and nothing is ever fresh-booted over its own snapshot. Migrating is the covered case;
 * refusing is still every other one.
 *
 * Each step names the version its answer is written under, so the chain is checked rather than
 * asserted: a row that migrates 1.1.0 to 1.2.0 and is left behind by a bump to 1.3.0 refuses the
 * old snapshot instead of handing the kernel a 1.2.0 state labelled 1.3.0.
 */

import {Option} from "effect";
import type {Migrations} from "../registry/program.ts";

/**
 * Walk `state` from the version it was written under to the version the program is now, one
 * declared step at a time. `none` is the refusal, and it has three causes: no step leaves the
 * version reached, a step read the bytes and declined them, or the chain revisits a version it has
 * already left — a cycle a row could otherwise declare and hang the boot on.
 */
export const migrateState = (
	migrations: Migrations | undefined,
	from: string,
	to: string,
	state: unknown,
): Option.Option<unknown> => {
	const walked = new Set<string>([from]);
	let version = from;
	let current = state;
	while (version !== to) {
		const step = migrations?.[version];
		if (step === undefined) return Option.none();
		if (walked.has(step.to)) return Option.none();
		const next = step.migrate(current);
		if (Option.isNone(next)) return Option.none();
		walked.add(step.to);
		current = next.value;
		version = step.to;
	}
	return Option.some(current);
};
