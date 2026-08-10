/**
 * The map body: its five sections, the entries each holds, the compare-and-set digest over them, and
 * the slice writes that change one section without touching the rest.
 *
 * Two properties this module exists to hold, both scars from v1's map:
 *
 * - **A line's section is not its state.** v1 encoded a ticket's state as which heading its bullet
 *   sat under, in a body no shipped tool wrote, then read it back "tolerantly" to cope with its own
 *   drift. Here the rows are a *rendering*: `../map/frontier.ts` resolves state from markers, issue
 *   state and edges, and this module only composes and parses the bytes.
 * - **A write is a slice, never a reconstruction.** {@link spliceSection} replaces the bytes of one
 *   section and copies the rest verbatim, so a concurrent edit to another section survives even when
 *   the digest guard admits the write.
 *
 * An **empty section is well-formed** and never refuses. A map at mint has an empty `## Decisions`,
 * `## Frontier` and `## Out of scope`; a parser that refused one would make every freshly minted map
 * unreadable by the next verb that touched it.
 */

import {createHash} from "node:crypto";

/** The five headings, in the one order a map body may carry them. */
export const SECTIONS = ["Destination", "Decisions", "Frontier", "Fog", "Out of scope"] as const;
export type SectionName = (typeof SECTIONS)[number];

/** What clears a frontier ticket. A fourth value is a drift, not a kind. */
export const KINDS = ["research", "prototype", "decision"] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (value: string): value is Kind => (KINDS as readonly string[]).includes(value);

/** One `## Frontier` row, as the body renders it. */
export interface FrontierRow {
	readonly ticket: number;
	readonly kind: Kind;
	readonly question: string;
	/** The `grilling` session or `prototyping` spike the question was routed to, when it was. */
	readonly forkedTo: number | null;
}

/** One `## Decisions` entry and the authority it cites. An entry citing neither does not parse. */
export interface DecisionEntry {
	readonly text: string;
	readonly authority:
		| {readonly _tag: "Ruled"; readonly session: number; readonly questionId: string}
		| {readonly _tag: "Finding"; readonly ticket: number};
}

/** One `## Out of scope` entry. The section only ever grows, so these are never removed. */
export interface OutOfScopeEntry {
	readonly direction: string;
	readonly reason: string;
	readonly recordedAt: string;
}

/** A parsed map body, plus the raw bytes and section spans a slice write needs. */
export interface MapBody {
	readonly raw: string;
	/** Each section's body bytes, headings excluded, in {@link SECTIONS} order. */
	readonly sections: ReadonlyArray<string>;
	/** `[start, end)` of each section's body inside {@link MapBody.raw}, in the same order. */
	readonly spans: ReadonlyArray<readonly [number, number]>;
	readonly destination: string;
	readonly decisions: ReadonlyArray<DecisionEntry>;
	readonly frontier: ReadonlyArray<FrontierRow>;
	/**
	 * How many non-blank lines `## Fog` holds.
	 *
	 * A count rather than a list because the section is free prose by contract: `map open` writes one
	 * bullet per opening question, but a later session may write a paragraph, and a parser that
	 * required bullets would refuse a body the spec permits.
	 */
	readonly fog: number;
	readonly outOfScope: ReadonlyArray<OutOfScopeEntry>;
}

export type BodyRead =
	| {readonly _tag: "Parsed"; readonly value: MapBody}
	| {readonly _tag: "Malformed"; readonly reason: string};

const HEADING = /^##[ \t]+(.+?)[ \t]*$/;

/**
 * The digest's normalisation: LF line endings, no trailing whitespace on any line, no leading or
 * trailing blank lines. Applied per section body, which is what makes the digest survive a
 * `normalizeForReadback` round trip byte-identically.
 */
export const normalizeSection = (text: string): string =>
	text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/^\n+/, "")
		.replace(/\n+$/, "");

/**
 * The compare-and-set token over the five section bodies, headings excluded.
 *
 * The exclusions are the invariant, not an optimisation: the digest must cover every byte a
 * concurrent writer could move and no byte this group never touches. No verb rewrites a heading, so
 * folding headings in would make another tool's heading-whitespace normalisation read as a lost
 * update; issue metadata is out for the same reason — `map open` writes the label once and nothing
 * else touches it.
 */
export const digestOf = (sections: ReadonlyArray<string>): string =>
	createHash("sha256").update(sections.map(normalizeSection).join("\n")).digest("hex").slice(0, 12);

const parseDecision = (entry: string): DecisionEntry | null => {
	const ruled = /^([\s\S]*?)\s+—\s+ruled on #(\d+)\s+(R\d+\.\d+)$/.exec(entry);
	if (ruled !== null) {
		return {
			text: (ruled[1] ?? "").trim(),
			authority: {
				_tag: "Ruled",
				session: Number.parseInt(ruled[2] ?? "0", 10),
				questionId: ruled[3] ?? "",
			},
		};
	}
	const finding = /^([\s\S]*?)\s+—\s+from #(\d+)$/.exec(entry);
	if (finding === null) return null;
	return {
		text: (finding[1] ?? "").trim(),
		authority: {_tag: "Finding", ticket: Number.parseInt(finding[2] ?? "0", 10)},
	};
};

const parseFrontier = (entry: string): FrontierRow | null => {
	const matched = /^#(\d+)\s+·\s+([a-z]+)\s+—\s+([\s\S]+)$/.exec(entry);
	if (matched === null) return null;
	const kind = matched[2] ?? "";
	if (!isKind(kind)) return null;
	const tail = matched[3] ?? "";
	const forked = /^([\s\S]*?)\s+—\s+forked to #(\d+)$/.exec(tail);
	return {
		ticket: Number.parseInt(matched[1] ?? "0", 10),
		kind,
		question: (forked === null ? tail : (forked[1] ?? "")).trim(),
		forkedTo: forked === null ? null : Number.parseInt(forked[2] ?? "0", 10),
	};
};

const parseOutOfScope = (entry: string): OutOfScopeEntry | null => {
	const matched = /^([\s\S]*?)\.\s+([\s\S]*?)\s+—\s+(\d{4}-\d{2}-\d{2})$/.exec(entry);
	if (matched === null) return null;
	const direction = (matched[1] ?? "").trim();
	const reason = (matched[2] ?? "").trim();
	if (direction === "" || reason === "") return null;
	return {direction, reason, recordedAt: matched[3] ?? ""};
};

/**
 * The `- ` entries of a section, each folded back onto one line with its continuation lines.
 *
 * Continuations are joined with a single space so an entry wrapped at the column limit parses the
 * same as one written on a single line — a rejection on line wrapping would refuse the body the
 * contract's own example shows.
 */
export const bulletEntries = (section: string): ReadonlyArray<string> | null => {
	const entries: string[] = [];
	for (const raw of normalizeSection(section).split("\n")) {
		if (raw.trim() === "") continue;
		const bullet = /^-[ \t]+(.*)$/.exec(raw);
		if (bullet !== null) {
			entries.push(bullet[1] ?? "");
			continue;
		}
		const last = entries.length - 1;
		if (last < 0 || !/^[ \t]/.test(raw)) return null;
		entries[last] = `${entries[last] ?? ""} ${raw.trim()}`;
	}
	return entries;
};

/**
 * Read a map body. Total: the five sections in order with every entry parsed, or the reason it is
 * not that.
 *
 * The reason is carried rather than a bare `false` because every caller quotes it into a `4` refusal,
 * and "the body does not parse" with no detail is a refusal nobody can act on.
 */
export const parseBody = (raw: string): BodyRead => {
	const text = raw.replace(/\r\n/g, "\n");
	const lines = text.split("\n");
	const found: {name: string; bodyStart: number; headingStart: number}[] = [];
	let offset = 0;
	for (const line of lines) {
		const heading = HEADING.exec(line);
		if (heading !== null) {
			found.push({
				name: heading[1] ?? "",
				headingStart: offset,
				bodyStart: Math.min(offset + line.length + 1, text.length),
			});
		}
		offset += line.length + 1;
	}

	const names = found.map((entry) => entry.name);
	if (names.length !== SECTIONS.length || names.some((name, i) => name !== SECTIONS[i])) {
		return {
			_tag: "Malformed",
			reason:
				names.length === 0
					? "the body carries no `## ` section heading at all"
					: `the body carries [${names.join(", ")}] rather than the five sections in order [${SECTIONS.join(", ")}]`,
		};
	}

	const spans = found.map(
		(entry, i): readonly [number, number] => [
			entry.bodyStart,
			i + 1 < found.length ? (found[i + 1]?.headingStart ?? text.length) : text.length,
		],
	);
	const sections = spans.map(([start, end]) => text.slice(start, end));

	const decisionsRaw = bulletEntries(sections[1] ?? "");
	if (decisionsRaw === null) {
		return {_tag: "Malformed", reason: "a `## Decisions` line is neither an entry nor a continuation"};
	}
	const decisions: DecisionEntry[] = [];
	for (const entry of decisionsRaw) {
		const parsed = parseDecision(entry);
		if (parsed === null) {
			return {
				_tag: "Malformed",
				reason: `the decision "${entry}" cites no authority — expected "— ruled on #<session> R<round>.<n>" or "— from #<ticket>"`,
			};
		}
		decisions.push(parsed);
	}

	const frontierRaw = bulletEntries(sections[2] ?? "");
	if (frontierRaw === null) {
		return {_tag: "Malformed", reason: "a `## Frontier` line is neither a row nor a continuation"};
	}
	const frontier: FrontierRow[] = [];
	for (const entry of frontierRaw) {
		const parsed = parseFrontier(entry);
		if (parsed === null) {
			return {
				_tag: "Malformed",
				reason: `the frontier row "${entry}" is not "#<n> · <${KINDS.join("|")}> — <question>"`,
			};
		}
		frontier.push(parsed);
	}

	const outRaw = bulletEntries(sections[4] ?? "");
	if (outRaw === null) {
		return {_tag: "Malformed", reason: "an `## Out of scope` line is neither an entry nor a continuation"};
	}
	const outOfScope: OutOfScopeEntry[] = [];
	for (const entry of outRaw) {
		const parsed = parseOutOfScope(entry);
		if (parsed === null) {
			return {
				_tag: "Malformed",
				reason: `the out-of-scope entry "${entry}" is not "<direction>. <reason> — <YYYY-MM-DD>"`,
			};
		}
		outOfScope.push(parsed);
	}

	return {
		_tag: "Parsed",
		value: {
			raw: text,
			sections,
			spans,
			destination: normalizeSection(sections[0] ?? ""),
			decisions,
			frontier,
			fog: normalizeSection(sections[3] ?? "")
				.split("\n")
				.filter((line) => line.trim() !== "").length,
			outOfScope,
		},
	};
};

/** The digest of a parsed body — the token every write guard compares against. */
export const digestOfBody = (body: MapBody): string => digestOf(body.sections);

/** One `## Frontier` row's bytes. */
export const renderFrontierRow = (row: FrontierRow): string =>
	`- #${row.ticket} · ${row.kind} — ${row.question}${row.forkedTo === null ? "" : ` — forked to #${row.forkedTo}`}`;

/** One `## Decisions` entry's bytes, with the citation the verb composes rather than the caller. */
export const renderDecision = (entry: DecisionEntry): string =>
	entry.authority._tag === "Ruled"
		? `- ${entry.text} — ruled on #${entry.authority.session} ${entry.authority.questionId}`
		: `- ${entry.text} — from #${entry.authority.ticket}`;

/** One `## Out of scope` entry's bytes. */
export const renderOutOfScope = (entry: OutOfScopeEntry): string =>
	`- ${entry.direction}. ${entry.reason} — ${entry.recordedAt}`;

/**
 * `body.raw` with one section's bytes replaced and every other byte copied verbatim.
 *
 * The surrounding blank lines are re-imposed rather than preserved so a section that was empty and a
 * section that held entries render identically after the splice — otherwise the first write to an
 * empty section would leave the heading glued to its first entry.
 */
export const spliceSection = (body: MapBody, section: SectionName, next: string): string => {
	const index = SECTIONS.indexOf(section);
	const span = body.spans[index];
	if (span === undefined) return body.raw;
	const trimmed = normalizeSection(next);
	const isLast = index === SECTIONS.length - 1;
	const replacement =
		trimmed === "" ? (isLast ? "" : "\n") : isLast ? `${trimmed}\n` : `${trimmed}\n\n`;
	return `${body.raw.slice(0, span[0])}${replacement}${body.raw.slice(span[1])}`;
};

/** The body `map open` mints: the destination, one fog bullet per question, three empty sections. */
export const renderMintBody = (
	destination: string,
	questions: ReadonlyArray<string>,
): string =>
	[
		"## Destination",
		destination,
		"",
		"## Decisions",
		"",
		"## Frontier",
		"",
		"## Fog",
		...questions.map((question) => `- ${question}`),
		"",
		"## Out of scope",
		"",
	].join("\n");
