/**
 * Tolerant markdown parsing for the two ledger surfaces the validator reads:
 * a child body's **acceptance-criteria checklist** and an epic body's
 * **`## Dependencies` topology**. Per the formats contract, these are
 * conventions to read tolerantly, not parser specs — recognize a section by its
 * heading shape (case-insensitive, synonyms allowed), not by exact whitespace.
 * Parsing is pure and deterministic: the same text always yields the same graph,
 * with node and edge sets emitted in a fixed order so a downstream signature is
 * stable.
 *
 * See `.claude/skills/gh-issue-intake-formats.md` §1 (the `## Dependencies`
 * grammar) and §2 (the ≥1-AC sub-issue invariant) for the source conventions.
 */
import type {DependencyEdge, DependencyGraph} from "./Ledger.ts";

const ISSUE_REF = /#(\d+)/g;

/** Lines that are an unordered-list checkbox item: `- [ ]`, `* [x]`, `+ [X]`. */
const CHECKBOX_ITEM = /^\s*[-*+]\s*\[[ xX]\]\s+\S/;

/** A `## Dependencies` (or `### Dependencies`) heading, tolerant of synonyms. */
const DEPS_HEADING = /^#{1,6}\s+depend(?:ency|encies|s)\b/i;

/** An `### Acceptance criteria` heading, tolerant of synonyms/casing. */
const AC_HEADING = /^#{1,6}\s+acceptance\s+criteria\b/i;

/** A `### Phase N` heading inside the dependencies section. */
const PHASE_HEADING = /^#{1,6}\s+phase\b/i;

/** Any markdown ATX heading line. */
const ANY_HEADING = /^#{1,6}\s+\S/;

const headingLevel = (line: string): number => {
	const match = /^(#{1,6})\s/.exec(line);
	return match?.[1] ? match[1].length : 0;
};

const uniqueSortedNumbers = (values: Iterable<number>): ReadonlyArray<number> =>
	[...new Set(values)].sort((a, b) => a - b);

/**
 * Count acceptance criteria in a child issue body: the checkbox items under the
 * first `### Acceptance criteria` heading, up to the next heading of the same or
 * higher level. A body with no such heading (or an empty section) counts zero —
 * which `validateLedger` reads as `ZERO_AC`. Counting checkboxes (not every
 * bullet) matches the format: a criterion is `- [ ] …`, prose bullets don't
 * count.
 */
export const countAcceptanceCriteria = (body: string): number => {
	const lines = body.split("\n");
	let inSection = false;
	let sectionLevel = 0;
	let count = 0;
	for (const line of lines) {
		if (!inSection) {
			if (AC_HEADING.test(line)) {
				inSection = true;
				sectionLevel = headingLevel(line);
			}
			continue;
		}
		if (ANY_HEADING.test(line) && headingLevel(line) <= sectionLevel) {
			break;
		}
		if (CHECKBOX_ITEM.test(line)) {
			count += 1;
		}
	}
	return count;
};

const collectIssueRefs = (line: string): ReadonlyArray<number> => {
	const refs: number[] = [];
	for (const match of line.matchAll(ISSUE_REF)) {
		refs.push(Number(match[1]));
	}
	return refs;
};

/** The issue numbers named in a `requires:` annotation on a dependency line. */
const collectRequires = (line: string): ReadonlyArray<number> => {
	const match = /requires:\s*([^)\n]*)/i.exec(line);
	if (!match?.[1]) return [];
	return collectIssueRefs(match[1]);
};

interface PhaseRow {
	readonly issue: number;
	readonly requires: ReadonlyArray<number>;
}

interface ParsedPhases {
	/** Phases in document order; each is the list of its rows. */
	readonly phases: ReadonlyArray<ReadonlyArray<PhaseRow>>;
	/** Every issue referenced anywhere in the section, including in `requires:`. */
	readonly nodes: ReadonlyArray<number>;
}

/**
 * Slice the `## Dependencies` section out of an epic body and lower it to phase
 * rows. A dependency *line* is a list item naming exactly one issue as its
 * subject (the first `#N` on the line); any further `#M` it carries are read as
 * `requires:` targets only when introduced by the `requires:` keyword. Lines
 * outside a `### Phase` heading still count as a single implicit phase, so a
 * flat bullet list (no phases) parses as one parallel group.
 */
const parsePhases = (body: string): ParsedPhases | undefined => {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => DEPS_HEADING.test(line));
	if (start === -1) return undefined;
	const depsLevel = headingLevel(lines[start] ?? "");

	const phases: PhaseRow[][] = [];
	const nodes = new Set<number>();
	let current: PhaseRow[] = [];
	const pushPhase = () => {
		if (current.length > 0) {
			phases.push(current);
			current = [];
		}
	};

	for (const line of lines.slice(start + 1)) {
		if (ANY_HEADING.test(line) && headingLevel(line) <= depsLevel) break;
		if (PHASE_HEADING.test(line)) {
			pushPhase();
			continue;
		}
		const refs = collectIssueRefs(line);
		const subject = refs[0];
		if (subject === undefined) continue;
		const requires = collectRequires(line);
		nodes.add(subject);
		for (const r of requires) nodes.add(r);
		current.push({issue: subject, requires});
	}
	pushPhase();

	return {phases, nodes: uniqueSortedNumbers(nodes)};
};

/**
 * Lower parsed phases to the gating edge relation, applying the formats
 * contract's two rules. A row's explicit `requires:` is the precise gate when
 * present; absent it, a row in phase *k* (k>0) waits on **every** issue in every
 * earlier phase (the phase-boundary default). Edges are emitted deduplicated and
 * sorted (`child` then `requires`) so the graph is order-independent.
 */
const lowerEdges = (
	phases: ReadonlyArray<ReadonlyArray<PhaseRow>>,
): ReadonlyArray<DependencyEdge> => {
	const edges = new Set<string>();
	const out: DependencyEdge[] = [];
	const add = (child: number, requires: number) => {
		if (child === requires) return;
		const key = `${child}->${requires}`;
		if (edges.has(key)) return;
		edges.add(key);
		out.push({child, requires});
	};

	const earlier: number[] = [];
	for (const phase of phases) {
		for (const row of phase) {
			if (row.requires.length > 0) {
				for (const r of row.requires) add(row.issue, r);
			} else {
				for (const prior of earlier) add(row.issue, prior);
			}
		}
		for (const row of phase) earlier.push(row.issue);
	}

	return out.sort((a, b) => a.child - b.child || a.requires - b.requires);
};

/**
 * Parse an epic body's `## Dependencies` section into a `DependencyGraph`. If
 * the section is absent, `present` is false and the graph is empty — the floor
 * reads that as `MISSING_DEPS_SECTION`. The returned node and edge sets are
 * canonically ordered, making the graph (and any signature over it)
 * order-independent.
 */
export const parseDependencyGraph = (body: string): DependencyGraph => {
	const parsed = parsePhases(body);
	if (!parsed) {
		return {present: false, nodes: [], edges: []};
	}
	return {
		present: true,
		nodes: parsed.nodes,
		edges: lowerEdges(parsed.phases),
	};
};
