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
 * A criterion may carry the **outside-diff evidence marker** — a trailing `[evidence: <source>]`
 * naming where the proof of that criterion lives when the diff's bytes cannot settle it either way:
 * a hand-verification section, a pre-fix artifact, a runtime observation. `triage` writes it at mint
 * time and `review` reads it back; the marker is parsed out of {@link AcceptanceCriterion.text} into
 * its own field, so a grader grades the sentence and routes on the field rather than pattern-matching
 * prose. A marker whose keyword drifted in case, or whose source is blank, is `Malformed` for the
 * same reason a drifted heading is: the defect must never be reported as the fact.
 *
 * An older pipeline's intake-format doc is where the semantics come from — read as prior art,
 * never called, so no code path here depends on a tree that is gone. Its reviewer-append provenance
 * tag (`<!-- ac:review-code … -->`) is deliberately not carried here.
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

declare const EVIDENCE_SOURCE: unique symbol;

/**
 * Where a marked criterion's proof lives, trimmed and non-blank.
 *
 * Branded for the same reason {@link CriterionText} is: a marker naming no source is the whole defect
 * this field exists to catch, and a `Found` carrying one would hand `review` a criterion that claims
 * outside-diff evidence and points at nothing. The read refuses it; the brand is what makes that
 * refusal the only way to build one.
 */
export type EvidenceSource = string & {readonly [EVIDENCE_SOURCE]: true};

export const evidenceSource = (raw: string): EvidenceSource | null => {
	const value = raw.trim();
	return value === "" ? null : (value as EvidenceSource);
};

/** One criterion, whether it is checked off, and where its proof lives. The field type of this format. */
export interface AcceptanceCriterion {
	readonly text: CriterionText;
	readonly checked: boolean;
	/**
	 * The outside-diff evidence marker's source, or `null` for an ordinary criterion the diff is
	 * expected to discharge on its own. `null` is not "unknown": it is the proven absence of a
	 * marker, and it is what keeps today's grading rule in force for every unmarked row.
	 */
	readonly evidence: EvidenceSource | null;
}

/** The marker's canonical keyword. Spelling and case are both part of it. */
export const EVIDENCE_KEYWORD = "evidence";

/**
 * A trailing HTML comment — machinery appended beside a criterion, never part of what it says.
 *
 * The evidence marker is the last thing an *author* writes, so it is matched after any such comment
 * is set aside and restored above it. Stated generically rather than against `review`'s own
 * provenance tag: this module carries no knowledge of that tag (see the docblock), and a rule that
 * named it would be a second definition of it.
 *
 * The body is `(?:[^-]|-(?!->))*` rather than a lazy `[\s\S]*?` because this runs over criterion text
 * that came out of an issue body, which is externally authored. Under the lazy form a `-` could be
 * consumed either by the body or by a repetition's `-->`, so `"<!--" + "--><!--".repeat(n)` backtracks
 * exponentially and the parser never returns — the one failure this module cannot report. Each
 * alternative here matches exactly one character and the two sets are disjoint, so every byte is
 * consumed one way only and the scan is linear.
 */
const TRAILING_COMMENTS = /(?:\s*<!--(?:[^-]|-(?!->))*-->)+\s*$/;

/** The marker as an author may write it — keyword captured as typed, so a case drift is visible. */
const EVIDENCE_TAIL = /\[[ \t]*([A-Za-z]+)[ \t]*:([^\]]*)\][ \t]*$/;

/** A criterion line split into what it says and where its proof lives. */
export type EvidenceSplit =
	| {
			readonly _tag: "Split";
			readonly text: string;
			readonly evidence: EvidenceSource | null;
	  }
	/** A marker is there and unusable — the keyword drifted, or it names no source. */
	| {readonly _tag: "Unusable"; readonly reason: string};

/**
 * Split the outside-diff evidence marker off a criterion's text.
 *
 * Wider than the conforming form on purpose, exactly as {@link reachesForBlock} is: a bracketed tail
 * whose keyword is `evidence` in any case is *reaching for* this marker, so `[Evidence: …]` is a
 * defect that gets named rather than a tail that silently stays prose. A bracketed tail whose
 * keyword is anything else is ordinary text and is left alone.
 */
export const splitEvidence = (raw: string): EvidenceSplit => {
	const comments = TRAILING_COMMENTS.exec(raw);
	const suffix = comments?.[0] ?? "";
	const head = suffix === "" ? raw : raw.slice(0, raw.length - suffix.length);
	const tail = EVIDENCE_TAIL.exec(head.trimEnd());
	if (tail === null) return {_tag: "Split", text: raw, evidence: null};
	const keyword = tail[1] ?? "";
	if (keyword.toLowerCase() !== EVIDENCE_KEYWORD) return {_tag: "Split", text: raw, evidence: null};
	if (keyword !== EVIDENCE_KEYWORD) {
		return {
			_tag: "Unusable",
			reason: `the outside-diff evidence marker's keyword has drifted — "${keyword}", expected "${EVIDENCE_KEYWORD}"`,
		};
	}
	const source = evidenceSource(tail[2] ?? "");
	if (source === null) {
		return {
			_tag: "Unusable",
			reason: `the outside-diff evidence marker names no source — "[${EVIDENCE_KEYWORD}: <where the proof lives>]" is the grammar`,
		};
	}
	const trimmed = head.trimEnd();
	return {
		_tag: "Split",
		text: `${trimmed.slice(0, trimmed.length - (tail[0] ?? "").length).trimEnd()}${suffix.trimEnd()}`,
		evidence: source,
	};
};

/**
 * A criterion's text with its evidence marker removed, or unchanged where it carries none.
 *
 * For a caller holding raw criterion bytes it did not read through this module — `review append`'s
 * read-back compares what it sent against what the reader answered, and the reader has already split
 * the marker off.
 */
export const withoutEvidenceMarker = (raw: string): string => {
	const split = splitEvidence(raw);
	return split._tag === "Split" ? split.text : raw;
};

/** Compose one criterion's line text: what it says, then its marker where it carries one. */
export const renderCriterionText = ({text, evidence}: AcceptanceCriterion): string =>
	evidence === null ? text : `${text} [${EVIDENCE_KEYWORD}: ${evidence}]`;

export type AcceptanceCriteriaRead = WireRead<NonEmptyReadonlyArray<AcceptanceCriterion>>;

/**
 * One criterion and the physical lines it occupies — `firstLine` its checkbox line, `lastLine` the
 * last continuation folded into its text. Both are 0-based indices into the body, inclusive.
 *
 * A criterion's *text* cannot locate its own lines once it wraps: the text is the joined sentence
 * while the checkbox line carries only its first segment, so a caller matching one against the
 * other finds nothing and reads that as "no such row". Anything writing beside a criterion
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
 * Is this line already a checkbox item?
 *
 * Exported for `triage repair-criteria`'s bullet conversion, which must leave untouched exactly the
 * lines this reader counts as criteria. A second regex over there would be a second definition of
 * "checkbox item", and the two would drift.
 */
export const isCheckboxItem = (line: string): boolean => CHECKBOX_ITEM.test(line);

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
 * next checkbox item does, so each closes the open criterion here. Tested after
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

/** One line of the contract region, carrying the 1-based number it sits on in the whole body. */
export interface RegionLine {
	readonly line: number;
	readonly text: string;
}

/**
 * The body's **contract region**: every line outside a fenced code block and outside a `<details>`
 * block, with the fence and `<details>` delimiters themselves dropped.
 *
 * The `<details>` rule is what makes an enriched body readable. `triage enrich` composes
 * `authored region + marker + preserved original`, and the preserved original is kept verbatim
 * inside a `<details>` block — so a legacy `## Acceptance criteria` buried there used to be a
 * candidate, and the composed body read `Malformed` (drifted heading) or `Malformed` (two
 * conforming headings) over an authored block that was clean. A collapsed block is an
 * appendix, never the contract: it renders folded shut, so nothing a grader must read lives in it.
 * Skipping it here rather than at compose time is what covers the bodies already wrapped — the
 * board's whole enriched corpus — and not only the ones wrapped from now on.
 *
 * An unclosed `<details>` swallows the rest of the body, exactly as the GitHub render does.
 *
 * Exported so every reader that judges a body scans the same bytes: `triage repair-criteria` locates
 * a drifted heading under exactly the rules this module refuses it under, and `triage enrich`'s
 * stated-ordering scan (`../triage/ordering.ts`) reads the same region. A second walk would be a
 * second definition of where the contract lives.
 */
export const contractRegionLines = (lines: ReadonlyArray<string>): ReadonlyArray<RegionLine> => {
	const region: RegionLine[] = [];
	let openFence: string | null = null;
	let detailsDepth = 0;
	for (const [index, text] of lines.entries()) {
		const fence = FENCE.exec(text);
		if (fence !== null) {
			const marker = fence[1] ?? "";
			if (openFence === null) openFence = marker;
			else if (openFence === marker) openFence = null;
			continue;
		}
		if (openFence !== null) continue;
		if (DETAILS_OPEN.test(text)) {
			detailsDepth += 1;
			continue;
		}
		if (DETAILS_CLOSE.test(text)) {
			detailsDepth = Math.max(0, detailsDepth - 1);
			continue;
		}
		if (detailsDepth > 0) continue;
		region.push({line: index + 1, text});
	}
	return region;
};

/**
 * Every ATX heading in the contract region — neither a fenced example nor a collapsed appendix may
 * pass for the real one.
 */
export const scanHeadings = (lines: ReadonlyArray<string>): ReadonlyArray<Heading> => {
	const headings: Heading[] = [];
	for (const {line, text} of contractRegionLines(lines)) {
		const heading = ATX_HEADING.exec(text);
		if (heading === null) continue;
		headings.push({level: (heading[1] ?? "").length, text: heading[2] ?? "", line});
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
 * before its first heading has them read back as criteria the author never wrote.
 *
 * Exported for `triage repair-criteria`, which rewrites item shape inside exactly the extent this
 * reader grades — the same reason {@link scanHeadings} is exported.
 */
export const sectionOf = (
	lines: ReadonlyArray<string>,
	heading: Heading,
): ReadonlyArray<string> => {
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
 * and said nothing about it — which is the defect this rule closes. The loss landed on the
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
 *    prose into the contract, the same defect pointing the other way,
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
 * Which block is served when a body carries more than one: the **last** conforming block is the
 * contract, because amend-never-rewrite appends a re-scope below the original; a candidate that
 * misses the spelling *below* the served block is `Malformed` rather than dropped, and one above it
 * stays dropped. The selection lives here and nowhere else, because a second copy of it is a second
 * answer to "which block is the contract".
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
	const heading = conforming[conforming.length - 1];
	if (heading === undefined) {
		return malformed("the acceptance-criteria heading could not be resolved", "");
	}

	const nearMissBelow = candidates.find(
		(candidate) => candidate.line > heading.line && !conforms(candidate),
	);
	if (nearMissBelow !== undefined) {
		return malformed(
			`a heading below the acceptance-criteria block reaches for it and misses — heading text "${nearMissBelow.text}" at line ${nearMissBelow.line}; an amendment re-posts its whole revised list under "${"#".repeat(HEADING_LEVEL)} ${HEADING_TEXT}"`,
			quote(nearMissBelow),
		);
	}

	const criteria: CriterionSpan[] = [];
	let open: OpenCriterion | null = null;
	let openFence: string | null = null;
	// `close` answers the unusable evidence marker rather than recording it, so every one of its call
	// sites below refuses where the defect is found. A flag set inside the closure would be a second
	// state to keep in step with `open`, and the walk has enough of those.
	const close = (): WireMalformed | null => {
		if (open === null) return null;
		const joined = joinContinuations(open.parts);
		const split = splitEvidence(joined);
		if (split._tag === "Unusable") {
			const at = `line ${open.firstLine + 1}: "${joined}"`;
			open = null;
			return malformed(split.reason, at);
		}
		const text = criterionText(split.text);
		if (text !== null) {
			criteria.push({
				criterion: {text, checked: open.checked, evidence: split.evidence},
				firstLine: open.firstLine,
				lastLine: open.lastLine,
			});
		}
		open = null;
		return null;
	};

	for (const [offset, line] of sectionOf(lines, heading).entries()) {
		const at = heading.line + offset;
		const item = CHECKBOX_ITEM.exec(line);
		if (item !== null) {
			const closed = close();
			if (closed !== null) return closed;
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
			const closed = close();
			if (closed !== null) return closed;
			continue;
		}
		if (openFence !== null || line.trim() === "" || BLOCK_STARTER.test(line)) {
			const closed = close();
			if (closed !== null) return closed;
			continue;
		}
		if (open !== null) {
			open.parts.push(line.trim());
			open.lastLine = at;
		}
	}
	const closed = close();
	if (closed !== null) return closed;

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

/** Compose criteria into the block's bytes. Round-trips through {@link read}, marker included. */
export const emit = (criteria: NonEmptyReadonlyArray<AcceptanceCriterion>): string => {
	const items = criteria.map(
		(criterion) => `- [${criterion.checked ? "x" : " "}] ${renderCriterionText(criterion)}`,
	);
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
		const split = splitEvidence(match?.[2] ?? "");
		if (split._tag === "Unusable") {
			return {_tag: "Unusable", reason: `line ${index + 1}: ${split.reason} — "${line}"`};
		}
		const text = criterionText(split.text);
		if (text === null) {
			return {
				_tag: "Unusable",
				reason: `line ${index + 1} carries a checkbox marker and no criterion text: "${line}"`,
			};
		}
		criteria.push({
			text,
			checked: (match?.[1] ?? " ").toLowerCase() === "x",
			evidence: split.evidence,
		});
	}
	const [head, ...rest] = criteria;
	if (head === undefined) {
		return {_tag: "Unusable", reason: "no criterion lines — a block with no criteria is malformed"};
	}
	return {_tag: "Fields", criteria: [head, ...rest]};
};

/**
 * One `<state>\t<text>` line per criterion — the `wire read` answer for this format — with a third
 * `\t<evidence source>` column on a marked criterion and none on an unmarked one.
 *
 * The column is conditional rather than a placeholder on every row because the marker is rare and
 * the two-column row is what every reader of this answer already parses: a placeholder would put a
 * literal in the evidence position of rows that have no evidence, which is the shape a consumer
 * reads as "the evidence is `-`".
 */
export const renderCriteria = (
	criteria: NonEmptyReadonlyArray<AcceptanceCriterion>,
): NonEmptyReadonlyArray<string> => {
	const [head, ...rest] = criteria;
	const line = ({checked, text, evidence}: AcceptanceCriterion): string =>
		`${checked ? "checked" : "open"}\t${text}${evidence === null ? "" : `\t${evidence}`}`;
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
