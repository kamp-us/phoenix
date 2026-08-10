/**
 * The advisory caveats `plan verdict` records beside the verdict — a closed set of kinds, and a
 * model-authored tail.
 *
 * **Caveats annotate; they never block.** There is no code path from a caveat to a polarity (ADR 0047
 * D2), and **no verb reads a caveat back as input** — it is a note for a human, never a signal a lane
 * consumes. That is what makes the free-prose tail a bounded exception to the closed-vocabulary rule
 * rather than a hole in it: the *kind* is closed and checked, the tail is inert.
 */

export const CAVEAT_KINDS = [
	"ac-not-checkable",
	"brief-fidelity",
	"slice-too-broad",
	"dependency-implied-not-declared",
] as const;

export type CaveatKind = (typeof CAVEAT_KINDS)[number];

export interface Caveat {
	readonly kind: CaveatKind;
	readonly ref: number;
	readonly text: string;
}

export type CaveatRead =
	| {readonly _tag: "Caveats"; readonly caveats: ReadonlyArray<Caveat>}
	/** A line that is not a caveat at all — refused, never dropped. */
	| {readonly _tag: "Unparseable"; readonly line: string}
	| {readonly _tag: "OffEnum"; readonly kind: string};

const CAVEAT_LINE = /^caveat:\s*([a-z-]+)\s+#(\d+)\s*(?:—|–|--)\s*(.+)$/i;

const isKind = (value: string): value is CaveatKind =>
	(CAVEAT_KINDS as ReadonlyArray<string>).includes(value);

/** One caveat per non-blank line. An empty input is an ordinary answer, not a refusal. */
export const readCaveats = (text: string): CaveatRead => {
	const caveats: Caveat[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const matched = CAVEAT_LINE.exec(line);
		if (matched?.[1] === undefined || matched[2] === undefined || matched[3] === undefined) {
			return {_tag: "Unparseable", line};
		}
		const kind = matched[1].toLowerCase();
		if (!isKind(kind)) return {_tag: "OffEnum", kind};
		caveats.push({kind, ref: Number.parseInt(matched[2], 10), text: matched[3].trim()});
	}
	return {_tag: "Caveats", caveats};
};

/** The caveats rendered verbatim under their kinds, in the closed set's order. */
export const renderCaveats = (caveats: ReadonlyArray<Caveat>): string => {
	const sections: string[] = [];
	for (const kind of CAVEAT_KINDS) {
		const under = caveats.filter((caveat) => caveat.kind === kind);
		if (under.length === 0) continue;
		sections.push(
			[`### ${kind}`, ...under.map((caveat) => `- #${caveat.ref} — ${caveat.text}`)].join("\n"),
		);
	}
	return sections.join("\n\n");
};
