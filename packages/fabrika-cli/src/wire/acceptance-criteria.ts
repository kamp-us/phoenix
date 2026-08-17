/**
 * The acceptance-criteria block — the founding wire format.
 *
 * An issue body carries the contract a gate grades a PR against as a `### Acceptance criteria`
 * heading over a list of checkbox items. Every grader in the pipeline reads it, and until this
 * module nothing in fabrika pinned it: the shape lived in prose, so a heading that drifted by one
 * character read back as an empty list and a grader passed over nothing.
 *
 * `read` is total and its three answers are the whole design (see `./format.ts`). The
 * discrimination that carries the weight is **Absent vs Malformed**: a body with no acceptance
 * criteria at all is a fact worth reporting, while a body whose heading drifted is a *defect* — and
 * the defect must never be reported as the fact. So a heading that is recognisably *reaching for*
 * this block, and misses, is `Malformed`; only a body where nothing reaches for it at all is
 * `Absent`. Neither is an answer on stdout: the adapter seats them on distinct non-zero codes
 * (`./codes.ts`).
 *
 * The scan runs over the body's *contract* region, not its bytes end to end: a fenced code block
 * and a `<details>` appendix are both out of reach (see {@link scanHeadings}).
 *
 * v1's `claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md` §2 is where the semantics
 * come from — read as prior art, never called (ADR 0238). Its reviewer-append provenance tag
 * (`<!-- ac:review-code … -->`) is deliberately not carried here.
 */

import type {
	NonEmptyReadonlyArray,
	WireEmit,
	WireMalformed,
	WireRead,
	WireReadLines,
} from "./format.ts";

declare const CRITERION_TEXT: unique symbol;

/**
 * What a criterion says, trimmed and non-blank.
 *
 * Branded for the same reason `HeadSha` is: a checkbox with nothing after it is not a criterion, and
 * a `Found` carrying one would be a well-formed answer that grades a PR against nothing. The read
 * refused it before; the brand is what makes the refusal the only way to build one.
 */
export type CriterionText = string & {readonly [CRITERION_TEXT]: true};

export const criterionText = (raw: string): CriterionText | null => {
	const value = raw.trim();
	return value === "" ? null : (value as CriterionText);
};

/** One criterion and whether it is checked off. The field type of this format. */
export interface AcceptanceCriterion {
	readonly text: CriterionText;
	readonly checked: boolean;
}

export type AcceptanceCriteriaRead = WireRead<NonEmptyReadonlyArray<AcceptanceCriterion>>;

/**
 * One criterion and the physical lines it occupies — `firstLine` its checkbox line, `lastLine` the
 * last continuation folded into its text. Both are 0-based indices into the body, inclusive.
 *
 * A criterion's *text* cannot locate its own lines once it wraps: the text is the joined sentence
 * while the checkbox line carries only its first segment, so a caller matching one against the
 * other finds nothing and reads that as "no such row" (#5716). Anything writing beside a criterion
 * takes the span from here instead of re-deriving the wrapping rule at the call site.
 */
export interface CriterionSpan {
	readonly criterion: AcceptanceCriterion;
	readonly firstLine: number;
	readonly lastLine: number;
}

export type AcceptanceCriteriaSpans = WireRead<NonEmptyReadonlyArray<CriterionSpan>>;

/** The one conforming heading. Level and spelling are both part of it. */
export const HEADING_LEVEL = 3;
export const HEADING_TEXT = "Acceptance criteria";

/** The heading text with case and punctuation removed — what a near-miss is measured against. */
const HEADING_KEY = "acceptancecriteria";

/**
 * How far a normalised heading may sit from {@link HEADING_KEY} and still count as reaching for
 * this block. Three edits covers the drifts seen in the wild — a dropped letter, a transposition, a
 * singular/plural swap — without swallowing an unrelated heading, which would misreport `Absent` as
 * `Malformed`. Both are refusals, so the cost of being wrong here is a worse message, never a
 * plausible answer.
 */
const NEAR_MISS_EDITS = 3;

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(```|~~~)/;
const CHECKBOX_ITEM = /^[ \t]*[-*][ \t]+\[([ xX])\][ \t]*(.*)$/;

/**
 * A `<details>` block's own opening and closing lines.
 *
 * Whole-line and nothing else: an envelope writes its opener on a line of its own, so matching only
 * that shape cannot mistake prose mentioning the tag for a block boundary.
 */
const DETAILS_OPEN = /^[ \t]*<details(?:[ \t][^>]*)?>[ \t]*$/;
const DETAILS_CLOSE = /^[ \t]*<\/details>[ \t]*$/;

/**
 * A line that opens a GFM block of its own beside the item — a plain bullet, an ordered-list marker,
 * a blockquote, or a thematic break. Each leaves the item's paragraph in the render exactly as the
 * next checkbox item does, so each closes the open criterion here (#5596). Tested after
 * {@link CHECKBOX_ITEM}, which owns the task-list forms this would otherwise swallow.
 */
const BLOCK_STARTER =
	/^[ \t]*(?:[-*+][ \t]+|\d{1,9}[.)][ \t]+|>|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

export interface Heading {
	readonly level: number;
	readonly text: string;
	/** 1-based, so a refusal can point at a line a human can find. */
	readonly line: number;
}

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Levenshtein distance, capped: anything past `limit` is reported as `limit + 1`. */
const editDistance = (a: string, b: string, limit: number): number => {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	let previous = Array.from({length: b.length + 1}, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i, ...Array.from<number>({length: b.length}).fill(0)];
		for (let j = 1; j <= b.length; j++) {
			const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
			const deletion = (previous[j] ?? 0) + 1;
			const insertion = (current[j - 1] ?? 0) + 1;
			current[j] = Math.min(substitution, deletion, insertion);
		}
		previous = current;
	}
	return previous[b.length] ?? limit + 1;
};

/**
 * Does this heading reach for the acceptance-criteria block?
 *
 * Deliberately wider than the conforming form: every heading this admits and then rejects becomes a
 * `Malformed` naming the drift, and every one it turns away becomes an `Absent`. Erring wide is
 * what keeps a drifted heading from being reported as "there were none".
 */
const reachesForBlock = (headingText: string): boolean => {
	const key = normalize(headingText);
	return (
		key.includes("acceptance") ||
		key.includes("criteri") ||
		editDistance(key, HEADING_KEY, NEAR_MISS_EDITS) <= NEAR_MISS_EDITS
	);
};

/**
 * Every ATX heading outside a fenced code block **and outside a `<details>` block** — neither a
 * fenced example nor a collapsed appendix may pass for the real one.
 *
 * The `<details>` rule is what makes an enriched body readable. `triage enrich` composes
 * `authored region + marker + preserved original`, and the preserved original is kept verbatim
 * inside a `<details>` block — so a legacy `## Acceptance criteria` buried there used to be a
 * candidate, and the composed body read `Malformed` (drifted heading) or `Malformed` (two
 * conforming headings) over an authored block that was clean (#5852). A collapsed block is an
 * appendix, never the contract: it renders folded shut, so nothing a grader must read lives in it.
 * Skipping it here rather than at compose time is what covers the bodies already wrapped — the
 * board's whole enriched corpus — and not only the ones wrapped from now on.
 *
 * An unclosed `<details>` swallows the rest of the body, exactly as the GitHub render does.
 *
 * Exported for `triage repair-criteria`, which must locate a drifted heading by exactly the rules
 * this reader refuses it under — a second scanner would be a second definition of "heading".
 */
export const scanHeadings = (lines: ReadonlyArray<string>): ReadonlyArray<Heading> => {
	const headings: Heading[] = [];
	let openFence: string | null = null;
	let detailsDepth = 0;
	for (const [index, line] of lines.entries()) {
		const fence = FENCE.exec(line);
		if (fence !== null) {
			const marker = fence[1] ?? "";
			if (openFence === null) openFence = marker;
			else if (openFence === marker) openFence = null;
			continue;
		}
		if (openFence !== null) continue;
		if (DETAILS_OPEN.test(line)) {
			detailsDepth += 1;
			continue;
		}
		if (DETAILS_CLOSE.test(line)) {
			detailsDepth = Math.max(0, detailsDepth - 1);
			continue;
		}
		if (detailsDepth > 0) continue;
		const heading = ATX_HEADING.exec(line);
		if (heading === null) continue;
		headings.push({
			level: (heading[1] ?? "").length,
			text: heading[2] ?? "",
			line: index + 1,
		});
	}
	return headings;
};

const conforms = (heading: Heading): boolean =>
	heading.level === HEADING_LEVEL && heading.text === HEADING_TEXT;

const quote = (heading: Heading): string =>
	`line ${heading.line}: "${"#".repeat(heading.level)} ${heading.text}"`;

const driftReason = (heading: Heading): string => {
	const levelWrong = heading.level !== HEADING_LEVEL;
	const textWrong = heading.text !== HEADING_TEXT;
	const parts = [
		levelWrong ? `heading level ${heading.level}, expected ${HEADING_LEVEL}` : null,
		textWrong ? `heading text "${heading.text}", expected "${HEADING_TEXT}"` : null,
	].filter((part): part is string => part !== null);
	return `the acceptance-criteria heading has drifted — ${parts.join("; ")}`;
};

/**
 * The lines under `heading`, up to the next heading outside a fence, the opening line of a
 * `<details>` block, or the end of the body.
 *
 * A `<details>` opener ends the section for the same reason {@link scanHeadings} skips inside one:
 * the collapsed block is an appendix. Without it, a preserved original that opens on checkbox lines
 * before its first heading has them read back as criteria the author never wrote (#5852).
 */
const sectionOf = (lines: ReadonlyArray<string>, heading: Heading): ReadonlyArray<string> => {
	const body: string[] = [];
	let openFence: string | null = null;
	for (const line of lines.slice(heading.line)) {
		const fence = FENCE.exec(line);
		if (fence !== null) {
			const marker = fence[1] ?? "";
			if (openFence === null) openFence = marker;
			else if (openFence === marker) openFence = null;
			body.push(line);
			continue;
		}
		if (openFence === null && (ATX_HEADING.test(line) || DETAILS_OPEN.test(line))) break;
		body.push(line);
	}
	return body;
};

/**
 * Where one criterion's text ends — the whole of the wrapping rule, stated once.
 *
 * A criterion that wraps onto a second physical line is still *one* criterion: GitHub's own `gfm`
 * render puts both lines inside one `<li class="task-list-item">`, joined by a `<br>`. A reader
 * that kept only line one therefore handed every grader a shorter contract than the author wrote,
 * and said nothing about it — which is the defect this rule closes (#5572). The loss landed on the
 * qualifiers and the "must not" clauses, because those are the half of a criterion that wraps.
 *
 * A line closes the open criterion when the CommonMark render also treats it as leaving the item's
 * paragraph:
 *
 * 1. a blank line,
 * 2. the next checkbox item — including a *nested* one, which is why a sub-item stays its own
 *    criterion and is never absorbed into its parent's text,
 * 3. a fence delimiter, and every line inside the fence it opens,
 * 4. any other line that opens a block of its own — a plain bullet, an ordered-list marker, a
 *    blockquote, a thematic break ({@link BLOCK_STARTER}). Joining those swallowed a sibling block's
 *    prose into the contract, the same defect pointing the other way (#5596),
 * 5. the heading that ends the section — {@link sectionOf} already cuts there, so the loop ends.
 *
 * Only a line that continues the item's own paragraph — the wrap this rule exists for — is appended.
 */
interface OpenCriterion {
	readonly parts: string[];
	readonly checked: boolean;
	readonly firstLine: number;
	lastLine: number;
}

/**
 * Join a criterion's lines into its text: each continuation trimmed of its indentation, joined with
 * one space, and interior whitespace runs collapsed so the answer carries no newline and no run.
 *
 * The collapse is skipped for an unwrapped criterion so that the single-line answer stays
 * byte-for-byte what it was before the join existed — this widens `Found`, it does not restate it.
 */
const joinContinuations = (parts: ReadonlyArray<string>): string => {
	const [head, ...rest] = parts;
	if (head === undefined) return "";
	if (rest.length === 0) return head;
	return [head, ...rest].join(" ").replace(/\s+/g, " ").trim();
};

const malformed = (reason: string, evidence: string): WireMalformed => ({
	_tag: "Malformed",
	reason,
	evidence,
});

/**
 * Read the block as criteria *with their line spans*. Total: `Found` | `Absent` | `Malformed`.
 *
 * {@link read} is this answer with the spans dropped, so there is one scanner and one wrapping rule
 * for both — a second one would be a second definition of "criterion".
 *
 * `Found` is unreachable with zero criteria — the only `return` that produces it is guarded by the
 * emptiness check below and the type would reject it regardless.
 */
export const readSpans = (body: string): AcceptanceCriteriaSpans => {
	const lines = body.split("\n");
	const candidates = scanHeadings(lines).filter((heading) => reachesForBlock(heading.text));
	if (candidates.length === 0) {
		return {
			_tag: "Absent",
			reason: `no heading in the body reaches for "${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}"`,
		};
	}

	const conforming = candidates.filter(conforms);
	const first = candidates[0];
	if (conforming.length === 0 && first !== undefined) {
		return malformed(driftReason(first), quote(first));
	}
	if (conforming.length > 1) {
		return malformed(
			`the body carries ${conforming.length} acceptance-criteria headings — which one is the contract is undecidable`,
			conforming.map(quote).join(" | "),
		);
	}

	const heading = conforming[0];
	if (heading === undefined) {
		return malformed("the acceptance-criteria heading could not be resolved", "");
	}

	const criteria: CriterionSpan[] = [];
	let open: OpenCriterion | null = null;
	let openFence: string | null = null;
	const close = (): void => {
		if (open === null) return;
		const text = criterionText(joinContinuations(open.parts));
		if (text !== null) {
			criteria.push({
				criterion: {text, checked: open.checked},
				firstLine: open.firstLine,
				lastLine: open.lastLine,
			});
		}
		open = null;
	};

	for (const [offset, line] of sectionOf(lines, heading).entries()) {
		const at = heading.line + offset;
		const item = CHECKBOX_ITEM.exec(line);
		if (item !== null) {
			close();
			const text = criterionText(item[2] ?? "");
			if (text === null) {
				return malformed(
					"a checkbox item under the acceptance-criteria heading carries no text",
					`line ${at + 1}: "${line}"`,
				);
			}
			open = {
				parts: [text],
				checked: (item[1] ?? " ").toLowerCase() === "x",
				firstLine: at,
				lastLine: at,
			};
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence !== null) {
			const marker = fence[1] ?? "";
			if (openFence === null) openFence = marker;
			else if (openFence === marker) openFence = null;
			close();
			continue;
		}
		if (openFence !== null || line.trim() === "" || BLOCK_STARTER.test(line)) {
			close();
			continue;
		}
		if (open !== null) {
			open.parts.push(line.trim());
			open.lastLine = at;
		}
	}
	close();

	const [head, ...rest] = criteria;
	if (head === undefined) {
		return malformed(
			`"${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}" is present and its section holds no "- [ ]" checkbox item — every sub-issue carries at least one`,
			`line ${heading.line}`,
		);
	}
	return {_tag: "Found", value: [head, ...rest]};
};

/** Read the acceptance-criteria block out of an issue body — {@link readSpans} without the spans. */
export const read = (body: string): AcceptanceCriteriaRead => {
	const spans = readSpans(body);
	if (spans._tag !== "Found") return spans;
	const [head, ...rest] = spans.value;
	return {_tag: "Found", value: [head.criterion, ...rest.map((span) => span.criterion)]};
};

/** Compose criteria into the block's bytes. Round-trips through {@link read}. */
export const emit = (criteria: NonEmptyReadonlyArray<AcceptanceCriterion>): string => {
	const items = criteria.map(({checked, text}) => `- [${checked ? "x" : " "}] ${text}`);
	return `${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}\n\n${items.join("\n")}\n`;
};

export type AcceptanceFields =
	| {readonly _tag: "Fields"; readonly criteria: NonEmptyReadonlyArray<AcceptanceCriterion>}
	| {readonly _tag: "Unusable"; readonly reason: string};

const FIELD_LINE = /^(?:[-*][ \t]+)?(?:\[([ xX])\][ \t]*)?(.*)$/;

/**
 * Parse `emit`'s stdin into criteria: one per non-blank line, `[x]` / `[ ]` setting the state.
 *
 * A line that carries a state marker and no text is a refusal rather than a dropped line — silently
 * skipping it is how a caller composes a block with fewer criteria than it wrote.
 */
export const parseFields = (fields: string): AcceptanceFields => {
	const criteria: AcceptanceCriterion[] = [];
	for (const [index, raw] of fields.split("\n").entries()) {
		const line = raw.trim();
		if (line === "") continue;
		const match = FIELD_LINE.exec(line);
		const text = criterionText(match?.[2] ?? "");
		if (text === null) {
			return {
				_tag: "Unusable",
				reason: `line ${index + 1} carries a checkbox marker and no criterion text: "${line}"`,
			};
		}
		criteria.push({text, checked: (match?.[1] ?? " ").toLowerCase() === "x"});
	}
	const [head, ...rest] = criteria;
	if (head === undefined) {
		return {_tag: "Unusable", reason: "no criterion lines — a block with no criteria is malformed"};
	}
	return {_tag: "Fields", criteria: [head, ...rest]};
};

/** One `<state>\t<text>` line per criterion — the `wire read` answer for this format. */
export const renderCriteria = (
	criteria: NonEmptyReadonlyArray<AcceptanceCriterion>,
): NonEmptyReadonlyArray<string> => {
	const [head, ...rest] = criteria;
	const line = ({checked, text}: AcceptanceCriterion): string =>
		`${checked ? "checked" : "open"}\t${text}`;
	return [line(head), ...rest.map(line)];
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.criteria)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderCriteria(result.value)} : result;
};
