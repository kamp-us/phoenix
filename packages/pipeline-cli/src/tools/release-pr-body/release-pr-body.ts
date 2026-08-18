/**
 * The pure core of `release-pr-body` — take a standing Release PR body and give back one
 * release-please can still parse.
 *
 * #5946: release-please copies each commit subject verbatim into the Release PR body's changelog,
 * then on the NEXT run reads that body back through an HTML parser
 * (`PullRequestBody.parse` → `extractMultipleReleases`). Commit `d8d23de1`'s subject carried a
 * literal `<details>`, so the parser saw a second `<details>` element with no `<summary>` inside it
 * and `summary.match(...)` threw on `undefined` — every run since has died there, and the frozen
 * Release PR cannot groom. Escaping that one body by hand does not hold: the next green run rebuilds
 * the body from the same commit subject and re-poisons it.
 *
 * So the repair runs every time, before release-please reads: strip the brackets off every
 * HTML-looking tag EXCEPT the two lines release-please writes as structure itself. Those two lines
 * are the whole of its own HTML vocabulary in a manifest PR body — `<details><summary>component:
 * version</summary>` opening a per-package section and `</details>` closing it — so preserving them
 * exactly and neutralizing everything else leaves the parser exactly the elements it wrote.
 *
 * Brackets are stripped rather than entity-escaped because the parsed section text becomes the
 * GitHub Release notes on merge, where `&lt;details&gt;` inside a code span renders literally.
 */

/** The section-opening line release-please writes: `<details><summary>fabrika-cli: 0.3.0</summary>`. */
const SECTION_OPEN = /^<details><summary>[^<>]*<\/summary>$/;

/** The section-closing line release-please writes. */
const SECTION_CLOSE = /^<\/details>$/;

/**
 * An HTML-looking tag — `<name …>` or `</name>`. The shape mirrors what an HTML parser reads as an
 * element (`<` then a letter), which is exactly the set that can poison the body; a `<` no parser
 * opens a tag on, like `a < b`, is left alone.
 */
const HTML_TAG = /<\/?([A-Za-z][^<>]*)>/g;

/** What one line contributed: the repaired text plus the tags that lost their brackets. */
interface LineRepair {
	readonly line: string;
	readonly stripped: ReadonlyArray<string>;
}

const repairLine = (line: string): LineRepair => {
	if (SECTION_OPEN.test(line) || SECTION_CLOSE.test(line)) return {line, stripped: []};
	const stripped: Array<string> = [];
	const repaired = line.replace(HTML_TAG, (tag, name: string) => {
		stripped.push(tag);
		return name;
	});
	return {line: repaired, stripped};
};

/** A body's repair: the text release-please can parse, and every tag that had to lose its brackets. */
export interface BodyRepair {
	readonly body: string;
	readonly stripped: ReadonlyArray<string>;
}

/**
 * The Release PR body with every stray HTML-looking tag neutralized. `stripped` is empty exactly
 * when the body was already safe to parse, which is what lets a caller skip a no-op write.
 */
export const sanitizeReleaseBody = (body: string): BodyRepair => {
	const repairs = body.split("\n").map(repairLine);
	return {
		body: repairs.map((repair) => repair.line).join("\n"),
		stripped: repairs.flatMap((repair) => repair.stripped),
	};
};
