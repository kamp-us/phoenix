/**
 * The `## Dependencies` grammar — canonical here, validated by `build check --surface plan` and
 * rendered into an epic ledger by `ledger topology`.
 *
 * **This block is a rendering, never a source of blockedness.** #5387 ruled that every dependency
 * in fabrika sits behind GitHub's native `blocked_by` edges and that a prose block is at most a
 * picture of them; ADR 0301 extends that to standalone issues. `build eligible` therefore parses
 * nothing here — it reads the graph through `./blockedness.ts` (#5913). What still reads this
 * grammar reads it for planning and sequencing: the plan surface's well-formedness check, the
 * ledger renderer, and the epic machine emitter. A reader that wants to know whether work may start
 * asks the graph.
 *
 * **{@link requiredEdges} does not weaken that.** It reads the block to say which edges the graph
 * *owes*, so `ledger edges` can write them and the plan gate can red when the two disagree — the
 * picture is still never consulted at a build gate, and the picture is still never the thing a
 * builder waits on.
 *
 * The section holds only blank lines and list lines of two forms:
 *
 * ```
 * - phase <int>: <ref>[, <ref>…]
 * - <ref> requires: <ref>[, <ref>…]
 * ```
 *
 * where `<ref>` is `#<int>` or a ledger-local `C<int>`. An issue in phase *k* is blocked while any ref
 * in a phase below *k* is open; a `requires:` line blocks its subject while any ref it lists is open.
 *
 * **Any other non-blank line inside the section is unparseable, and unparseability refuses.** "No
 * parseable edges" is never read as "no edges" — a topology nobody could read is not a topology
 * proving nothing blocks (ADR 0092, #4104).
 *
 * **The section ends at the next ATX heading or at the first thematic break (`---`, `***`, `___`),
 * whichever comes first** — this is the canonical statement of that boundary, and `plan/ledger.ts`
 * reads its own sections through the `isThematicBreak` exported here rather than restating it. A
 * filed body is amended by appending a dated block below the original, and that block is
 * conventionally introduced by a bare `---`; with `## Dependencies` last, a heading-only boundary
 * put that separator inside the section and refused the whole topology over a line that was never
 * part of it (#5816).
 */

/** A reference in the topology: a real issue, or an id local to the ledger. */
export type Ref =
	| {readonly _tag: "Issue"; readonly number: number}
	| {readonly _tag: "Local"; readonly id: string};

export interface PhaseLine {
	readonly _tag: "Phase";
	readonly phase: number;
	readonly members: ReadonlyArray<Ref>;
}

export interface RequiresLine {
	readonly _tag: "Requires";
	readonly subject: Ref;
	readonly needs: ReadonlyArray<Ref>;
}

export type Edge = PhaseLine | RequiresLine;

export type Topology =
	| {readonly _tag: "Parsed"; readonly edges: ReadonlyArray<Edge>}
	/** The heading is not there at all. */
	| {readonly _tag: "Absent"}
	/** The heading is there and something under it does not parse — a defect, not an absence. */
	| {readonly _tag: "Unparseable"; readonly line: number; readonly text: string};

const HEADING_RE = /^##\s+Dependencies\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s+/;
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const PHASE_RE = /^-\s*phase\s+(\d+)\s*:\s*(.+)$/i;
const REQUIRES_RE = /^-\s*(\S+)\s+requires\s*:\s*(.+)$/i;

/**
 * A CommonMark thematic break: three or more `-`, `*` or `_`, optionally spaced, indented at most
 * three. Tested against the raw line, because the indent is part of the rule.
 */
export const isThematicBreak = (line: string): boolean => THEMATIC_BREAK_RE.test(line);

const parseRef = (raw: string): Ref | null => {
	const text = raw.trim();
	const issue = /^#(\d+)$/.exec(text);
	if (issue?.[1] !== undefined) return {_tag: "Issue", number: Number.parseInt(issue[1], 10)};
	return /^C\d+$/.test(text) ? {_tag: "Local", id: text} : null;
};

const parseRefList = (raw: string): ReadonlyArray<Ref> | null => {
	const parts = raw
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p !== "");
	if (parts.length === 0) return null;
	const refs: Ref[] = [];
	for (const part of parts) {
		const ref = parseRef(part);
		if (ref === null) return null;
		refs.push(ref);
	}
	return refs;
};

/** Read a body's `## Dependencies` block. */
export const readTopology = (body: string): Topology => {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => HEADING_RE.test(line.trim()));
	if (start === -1) return {_tag: "Absent"};

	const edges: Edge[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const text = raw.trim();
		if (text === "") continue;
		if (ANY_HEADING_RE.test(text) || isThematicBreak(raw)) break;

		const phase = PHASE_RE.exec(text);
		if (phase?.[1] !== undefined && phase[2] !== undefined) {
			const members = parseRefList(phase[2]);
			if (members === null) return {_tag: "Unparseable", line: i + 1, text};
			edges.push({_tag: "Phase", phase: Number.parseInt(phase[1], 10), members});
			continue;
		}
		const requires = REQUIRES_RE.exec(text);
		if (requires?.[1] !== undefined && requires[2] !== undefined) {
			const subject = parseRef(requires[1]);
			const needs = parseRefList(requires[2]);
			if (subject === null || needs === null) return {_tag: "Unparseable", line: i + 1, text};
			edges.push({_tag: "Requires", subject, needs});
			continue;
		}
		return {_tag: "Unparseable", line: i + 1, text};
	}
	return {_tag: "Parsed", edges};
};

export const sameRef = (a: Ref, b: Ref): boolean =>
	a._tag === "Issue" && b._tag === "Issue"
		? a.number === b.number
		: a._tag === "Local" && b._tag === "Local" && a.id === b.id;

export const renderRef = (ref: Ref): string => (ref._tag === "Issue" ? `#${ref.number}` : ref.id);

/**
 * Every predecessor of `subject`, with the kind of edge that names it.
 *
 * A `requires:` line is honoured as the **precise** gate when one is present: the planner naming a
 * strict subset is the planner saying "this specific edge is what matters". With no `requires:` line,
 * the phase boundary is the default and the subject waits on every earlier phase.
 */
export const predecessorsOf = (
	edges: ReadonlyArray<Edge>,
	subject: Ref,
): ReadonlyArray<{readonly kind: "phase" | "requires:"; readonly ref: Ref}> => {
	const explicit = edges.filter(
		(edge): edge is RequiresLine => edge._tag === "Requires" && sameRef(edge.subject, subject),
	);
	if (explicit.length > 0) {
		return explicit.flatMap((edge) => edge.needs.map((ref) => ({kind: "requires:" as const, ref})));
	}
	const phases = edges.filter((edge): edge is PhaseLine => edge._tag === "Phase");
	const own = phases.find((edge) => edge.members.some((ref) => sameRef(ref, subject)));
	if (own === undefined) return [];
	return phases
		.filter((edge) => edge.phase < own.phase)
		.flatMap((edge) => edge.members.map((ref) => ({kind: "phase" as const, ref})));
};

/** One `blocked_by` edge the block requires on the board: `dependent` waits on `prerequisite`. */
export interface RequiredEdge {
	readonly dependent: number;
	readonly prerequisite: number;
}

/**
 * Every `blocked_by` edge this block requires, deduped and ascending by `[dependent, prerequisite]`.
 *
 * The rendering is not the carrier, so a plan that only *says* `#N requires: #M` leaves the graph
 * empty and both build gates blind — which is how a child gated behind an unruled decision was
 * admitted for construction (#6616). This is the bridge: `ledger edges` writes what it names, and the
 * plan gate reds on a pair the board does not carry.
 *
 * The rule is {@link predecessorsOf}'s and is not restated — every subject the block names is asked
 * for its predecessors. Only `#<int>` refs become pairs: a ledger-local `C<int>` names no issue, so
 * no edge over it is writable and none is required. A self-pair is dropped as unwritable; `DEP_CYCLE`
 * is what reports it.
 */
export const requiredEdges = (edges: ReadonlyArray<Edge>): ReadonlyArray<RequiredEdge> => {
	const subjects = edges.flatMap((edge) =>
		edge._tag === "Phase" ? [...edge.members] : [edge.subject],
	);
	const pairs = new Map<string, RequiredEdge>();
	for (const subject of subjects) {
		if (subject._tag !== "Issue") continue;
		for (const {ref} of predecessorsOf(edges, subject)) {
			if (ref._tag !== "Issue" || ref.number === subject.number) continue;
			pairs.set(`${subject.number}>${ref.number}`, {
				dependent: subject.number,
				prerequisite: ref.number,
			});
		}
	}
	return [...pairs.values()].sort((a, b) =>
		a.dependent === b.dependent ? a.prerequisite - b.prerequisite : a.dependent - b.dependent,
	);
};
