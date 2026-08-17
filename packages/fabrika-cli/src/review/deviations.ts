/**
 * `review deviations`' view of the PR body's `## Deviations` section: which of four states it is in,
 * and what it discloses.
 *
 * The grammar is not here. It lives in `../wire/deviations.ts`, the registered format both this
 * reader and `build pr`'s body-shape check resolve against — one writer and one reader cannot
 * disagree about a shape neither of them owns (#5566). This module is the projection from the wire's
 * three answers onto the four states the review verdict vocabulary needs, and nothing else.
 *
 * The fourth state is why a projection is needed at all: `None.` is a *checked* claim, and
 * collapsing it into `absent` is how "never considered it" comes to read as "nothing to disclose".
 * The wire carries it as a `Found` of its own tag; this reader names it `none-declared`.
 */

import {read as readWire} from "../wire/deviations.ts";

export type DeviationsState = "found" | "none-declared" | "absent" | "malformed";

export interface DeviationEntry {
	/** The class label `1`–`7`, or `null` when the entry carries none this reader recognises. */
	readonly label: string | null;
	/** The entry's **Said** field — what the spec asked. */
	readonly said: string;
}

export interface DeviationsRead {
	readonly state: DeviationsState;
	readonly entries: ReadonlyArray<DeviationEntry>;
	/**
	 * Why the section is not readable, on `absent` and `malformed` — the wire's own reason.
	 *
	 * Carried so the verb can say *what* drifted. A gate that answers a bare `malformed` tells an
	 * author their body is wrong and never which field is missing, which is the round this issue's
	 * defect cost every time it fired.
	 */
	readonly reason: string | null;
}

export const readDeviations = (body: string): DeviationsRead => {
	const result = readWire(body);
	if (result._tag === "Absent") return {state: "absent", entries: [], reason: result.reason};
	if (result._tag === "Malformed") {
		return {state: "malformed", entries: [], reason: result.reason};
	}
	if (result.value._tag === "NoneDeclared") {
		return {state: "none-declared", entries: [], reason: null};
	}
	return {
		state: "found",
		entries: result.value.entries.map(({label, said}) => ({label, said})),
		reason: null,
	};
};
