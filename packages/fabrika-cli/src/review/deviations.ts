/**
 * The PR body's `## Deviations` section: which of four states it is in, and what it discloses.
 *
 * The four states stay distinct on the wire because the skill's verdict vocabulary depends on the
 * distinction — absent-on-owing fails closed, `None.` is a *checked* claim, and this reader is what
 * makes the claim checkable. Collapsing `absent` into `none-declared` is how "never considered it"
 * comes to read as "nothing to disclose".
 *
 * v1's §DEV supplied the semantics — the four fields, the seven classes, the M/R/D tiers — and was
 * read as prior art, never called (ADR 0238). Its heading detection is triplicated in awk across
 * three surfaces; this is one reader.
 */

export type DeviationsState = "found" | "none-declared" | "absent" | "malformed";

export interface DeviationEntry {
	/** The class label `1`–`7`, or `null` when the entry carries none this reader recognises. */
	readonly label: string | null;
	/** The first line of the entry's **Said** field — what the spec asked. */
	readonly said: string;
}

export interface DeviationsRead {
	readonly state: DeviationsState;
	readonly entries: ReadonlyArray<DeviationEntry>;
}

/**
 * The seven classes, keyed by their canonical names normalised to letters.
 *
 * The vocabulary is **this contract's, enumerated closed** — never a pointer into v1's prose. The
 * label is a routing hint, not the disclosure: a gate matches an entry's substance, never its label,
 * so an unrecognised label costs a `-` and nothing else.
 */
const CLASSES: ReadonlyArray<readonly [string, string]> = [
	["1", "scopenarrowing"],
	["2", "governingadrdeparture"],
	["3", "knowndefectleftunfixed"],
	["4", "declinedguidance"],
	["5", "guardorgatebypassed"],
	["6", "preexistingtestorfixturechanged"],
	["7", "outofscopechange"],
];

const HEADING = /^ {0,3}##[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const ANY_HEADING = /^ {0,3}#{1,6}[ \t]+/;
const FENCE = /^ {0,3}(?:```|~~~)/;
const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The lines under the `## Deviations` heading, or `null` when the body carries no such heading. */
const sectionOf = (body: string): ReadonlyArray<string> | null => {
	const lines = body.split("\n");
	let start = -1;
	let fenced = false;
	for (const [index, line] of lines.entries()) {
		if (FENCE.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		if (start >= 0) {
			if (ANY_HEADING.test(line)) return lines.slice(start, index);
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading !== null && normalize(heading[1] ?? "") === "deviations") start = index + 1;
	}
	return start >= 0 ? lines.slice(start) : null;
};

const labelOf = (lead: string): string | null => {
	const key = normalize(lead);
	const named = CLASSES.find(([, name]) => key.startsWith(name));
	if (named !== undefined) return named[0];
	const numeric = /^([1-7])\b/.exec(lead.trim());
	return numeric?.[1] ?? null;
};

/**
 * The `**Said:**` field's first line, or `null` when the bullet carries no `Said` at all.
 *
 * The emphasis is admitted on both sides of the colon: the canonical §DEV entry writes `**Said:**`,
 * closing the bold *after* the punctuation, so a pattern anchored only on `**Said**:` would leave the
 * closer at the head of every value it read.
 */
const saidOf = (text: string): string | null => {
	const at = /\*{0,2}said\*{0,2}\s*:\s*\*{0,2}/i.exec(text);
	if (at === null) return null;
	const rest = text.slice(at.index + at[0].length);
	const end = /\*{0,2}(?:did|why|disposition)\*{0,2}\s*:/i.exec(rest);
	const value = (end === null ? rest : rest.slice(0, end.index)).trim();
	return value.split("\n")[0]?.trim() ?? "";
};

/**
 * Each top-level `- ` bullet in the section, joined with its continuation lines.
 *
 * An entry spans several lines in practice — the four fields wrap — so a per-line read would report
 * one entry as four and lose every `Said` that started on the second line.
 */
const bulletsOf = (section: ReadonlyArray<string>): ReadonlyArray<string> => {
	const bullets: string[] = [];
	for (const line of section) {
		if (/^[ \t]{0,3}[-*][ \t]+/.test(line)) bullets.push(line.replace(/^[ \t]{0,3}[-*][ \t]+/, ""));
		else if (bullets.length > 0 && line.trim() !== "") bullets[bullets.length - 1] += `\n${line}`;
	}
	return bullets;
};

/** The bold or plain lead of a bullet — `**Scope narrowing**` — before the first field. */
const leadOf = (bullet: string): string => {
	const bold = /^\s*\*\*(.+?)\*\*/.exec(bullet);
	if (bold?.[1] !== undefined) return bold[1];
	return bullet.split(/[—–:]/)[0] ?? "";
};

export const readDeviations = (body: string): DeviationsRead => {
	const section = sectionOf(body);
	if (section === null) return {state: "absent", entries: []};

	const text = section.join("\n").trim();
	if (text === "") return {state: "malformed", entries: []};
	if (/^none\.?$/i.test(text)) return {state: "none-declared", entries: []};

	const entries: DeviationEntry[] = [];
	for (const bullet of bulletsOf(section)) {
		const said = saidOf(bullet);
		if (said === null) continue;
		entries.push({label: labelOf(leadOf(bullet)), said});
	}
	return entries.length === 0 ? {state: "malformed", entries: []} : {state: "found", entries};
};
