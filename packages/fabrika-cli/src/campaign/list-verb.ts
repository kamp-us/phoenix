/**
 * `campaign list` — the `## Campaigns` rows, parsed, optionally narrowed to one state.
 *
 * **Zero rows is a fact at exit `0`, not ADR 0092's red.** An absent table and an empty one are one
 * well-formed default: nothing declared means the dispatch fence is off, not closed (founder ruling
 * on #5011, carried onto this surface by ADR 0304). A judging verb would refuse here; this one
 * supplies an input, and its empty answer is true.
 *
 * **`none` means no row survived, never "nothing is active".** A table whose every row is `paused`
 * prints those rows — someone opened each one and the file says so. The dispatch question is
 * `--state active`, and only there does such a table answer `none`.
 */

import {Effect} from "effect";
import {CAMPAIGN_STATES} from "../build/scope-admission.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {type FileEffect, locateRoadmap, readRoadmap} from "./guards.ts";
import {rowLine} from "./table.ts";

export interface ListOptions {
	readonly state: string | null;
	readonly file: string | null;
	readonly json: boolean;
	readonly cwd: string;
}

const VERB = "campaign list";

export const runList = (options: ListOptions): FileEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const narrowing = options.state;
		if (narrowing !== null && !CAMPAIGN_STATES.some((legal) => legal === narrowing)) {
			return refuse(
				FAILED,
				`${VERB}: --state "${narrowing}" is not one of ${CAMPAIGN_STATES.join(", ")}.`,
			);
		}

		const located = yield* locateRoadmap(VERB, options.cwd, options.file);
		if (located._tag === "Refused") return located.outcome;
		const {display} = located.located;

		const read = yield* readRoadmap(VERB, located.located, "nothing was parsed");
		if (read._tag === "Refused") return read.outcome;

		const all = read.rows;
		const rows = narrowing === null ? all : all.filter((row) => row.state === narrowing);
		const active = all.filter((row) => row.state === "active").length;

		const scope = `${VERB}: read ${display} — ${all.length} campaign row(s), ${active} active; printed ${rows.length}.`;
		if (options.json) {
			return answer(`${JSON.stringify({rows, file: display})}\n`, [scope]);
		}
		return answer(rows.length === 0 ? "none\n" : `${rows.map(rowLine).join("\n")}\n`, [scope]);
	});
