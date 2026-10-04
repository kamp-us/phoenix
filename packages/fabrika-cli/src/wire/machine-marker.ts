/**
 * Whether a comment body is something a fabrika verb wrote, read off its shape.
 *
 * There is no closed list of marker keys to check against: more than forty verbs post comments, and
 * a list would be stale at the next one. What they share is two shapes, so the read is structural —
 * a line opening with a `<!-- fabrika…` or `<!-- ac:…` HTML comment, or a first non-blank line
 * opening with a hyphenated lowercase `<key>:`. A gate verdict is the one marker whose key carries
 * no hyphen (`review: PASS @ …`), so it is admitted through its own formats' reads.
 *
 * **A `decision-ruled:` line counts only when it conforms.** A drifted one is a ruling its author
 * tried to record and did not, which is the comment a reader most needs pointed at.
 *
 * **Free prose carries no marker, whoever posted it.** `build note` and its siblings write an
 * agent's prose under whatever account runs them, and nothing in those bytes tells it apart from a
 * person's. That limit is the caller's to state.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10309#issuecomment-5974136525
 */

import {KEY as RULING_KEY, read as readRuling} from "./decision-ruling.ts";
import {read as readRangeVerdict} from "./range-verdict-marker.ts";
import {read as readVerdict} from "./verdict-marker.ts";

const HTML_MARKER = /^\s*<!--\s*(?:fabrika[:-]|ac:)/m;

const KEY_LINE = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)+):(?:\s|$)/;

/** The first non-blank line with a skill's bold emphasis stripped, as every marker read takes it. */
const openingLine = (body: string): string =>
	(body.split("\n").find((line) => line.trim() !== "") ?? "").trim().replace(/^\*{0,2}\s*/, "");

export const carriesMachineMarker = (body: string): boolean => {
	if (HTML_MARKER.test(body)) return true;
	const key = KEY_LINE.exec(openingLine(body))?.[1];
	if (key === RULING_KEY) return readRuling(body)._tag === "Found";
	if (key !== undefined) return true;
	return readVerdict(body)._tag === "Found" || readRangeVerdict(body)._tag === "Found";
};
