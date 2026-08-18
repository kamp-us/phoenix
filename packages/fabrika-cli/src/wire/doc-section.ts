/**
 * One markdown section by heading — the lookup a shell runs instead of reading a whole contract.
 *
 * The section is the body under the matching ATX heading, from the line after it to the next
 * heading of equal or shallower depth (deeper subheadings stay inside). A heading inside a fenced
 * code block is not a heading — the hot contracts quote their own grammar in fences, and a match
 * there would hand a caller an example instead of the contract. The two refusals are proven facts,
 * kept apart because they demand different fixes: `Absent` (nothing to print) and `Duplicated`
 * (two sections with one name have no single meaning, so printing either would be a guess) (#5966).
 *
 * Fences follow CommonMark: an opener of three-or-more backticks or tildes closes only on a marker
 * of the same character at least as long, so a ```` ``` ```` nested inside a ```` ```` ```` example
 * does not end the outer fence.
 */

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

interface FoundHeading {
	readonly level: number;
	/** 1-based, so a refusal can point at a line a human can find. */
	readonly line: number;
}

export type DocSection =
	| {readonly _tag: "Found"; readonly body: string; readonly heading: FoundHeading}
	| {readonly _tag: "Absent"; readonly reason: string}
	| {readonly _tag: "Duplicated"; readonly reason: string; readonly evidence: string};

const closes = (open: string, marker: string): boolean =>
	marker[0] === open[0] && marker.length >= open.length;

/**
 * Whether a heading's text names `wanted`. The contracts backtick their verb names and fold
 * several into one heading (`` ## `build claim`, `build confirm`, `build release` ``), so the
 * comparison strips inline-code backticks and also admits one comma-separated segment — a caller
 * asks for the name it knows, not for the heading's whole punctuation.
 */
const names = (headingText: string, wanted: string): boolean => {
	if (headingText === wanted) return true;
	const stripped = headingText.replace(/`/g, "").trim();
	return stripped === wanted || stripped.split(",").some((segment) => segment.trim() === wanted);
};

/** Every ATX heading outside a fenced code block, with its depth and 1-based line. */
const scanHeadings = (
	lines: ReadonlyArray<string>,
): ReadonlyArray<FoundHeading & {readonly text: string}> => {
	const headings: Array<FoundHeading & {readonly text: string}> = [];
	let openFence: string | null = null;
	for (const [index, line] of lines.entries()) {
		const fence = FENCE.exec(line);
		if (fence !== null) {
			const marker = fence[1] ?? "";
			if (openFence === null) openFence = marker;
			else if (closes(openFence, marker)) openFence = null;
			continue;
		}
		if (openFence !== null) continue;
		const heading = ATX_HEADING.exec(line);
		if (heading === null) continue;
		headings.push({level: (heading[1] ?? "").length, text: heading[2] ?? "", line: index + 1});
	}
	return headings;
};

/**
 * The section under the one heading that {@link names} `heading` (trimmed, case-sensitive, any
 * depth). Leading and trailing blank lines are dropped from the body; interior lines are verbatim.
 */
export const extractSection = (markdown: string, heading: string): DocSection => {
	const wanted = heading.trim();
	const lines = markdown.split("\n");
	const matches = scanHeadings(lines).filter((candidate) => names(candidate.text, wanted));

	const [first, ...rest] = matches;
	if (first === undefined) {
		return {
			_tag: "Absent",
			reason: `no heading outside a code fence reads "${wanted}"`,
		};
	}
	if (rest.length > 0) {
		return {
			_tag: "Duplicated",
			reason: `${matches.length} headings read "${wanted}" — two sections with one name have no single meaning`,
			evidence: matches.map((match) => `line ${match.line}`).join(", "),
		};
	}

	const body: string[] = [];
	let openFence: string | null = null;
	for (const line of lines.slice(first.line)) {
		const fence = FENCE.exec(line);
		if (fence !== null) {
			const marker = fence[1] ?? "";
			if (openFence === null) openFence = marker;
			else if (closes(openFence, marker)) openFence = null;
			body.push(line);
			continue;
		}
		if (openFence === null) {
			const next = ATX_HEADING.exec(line);
			if (next !== null && (next[1] ?? "").length <= first.level) break;
		}
		body.push(line);
	}
	while (body.length > 0 && body[body.length - 1]?.trim() === "") body.pop();
	while (body.length > 0 && body[0]?.trim() === "") body.shift();

	return {
		_tag: "Found",
		body: body.join("\n"),
		heading: {level: first.level, line: first.line},
	};
};
