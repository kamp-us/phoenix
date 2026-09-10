/**
 * The declared topology: a line grammar in, a `## Dependencies` block out, and the round trip that
 * proves the two agree.
 *
 * **This module adds no second `## Dependencies` grammar.** It composes a block the shipped
 * `build/dependencies.ts` parser reads back, and the composed block is parsed through that very parser
 * before anything is staged. A block the gate's parser reads differently from how its author meant it
 * is exactly the class of defect nobody notices until a build runs in the wrong order — v1 had no
 * round-trip check at all, and the first time anyone learned the topology parsed differently than
 * intended was when the gate derived the wrong defects.
 *
 * The cycle walk runs over the **union** of the declared `requires` edges and the edges the phase
 * order implies, so a `requires` that contradicts its phases (a phase-1 child requiring a phase-2 one)
 * surfaces as the cycle it is rather than staging cleanly.
 *
 * **A phase member is a manifest child; a prerequisite need not be.** The decision corpus rules a
 * `requires:` reference to an issue another epic owns a legitimate gating edge, and only a reference
 * proven absent dangling. So the manifest closes over subjects alone, and every prerequisite outside it rides out in
 * {@link TopologyCheck}'s `external` for the verb to prove at the boundary — a pure module cannot ask
 * GitHub whether an issue exists.
 *
 * **The one prerequisite refused before that boundary is the epic's own number.** It is not dangling
 * — the epic exists, so the boundary prove answers Present and the line stages — and it is not a
 * cycle either, since {@link findCycle} walks the declared lines and every node in those is a child.
 * `ledger edges` then writes the child `blocked_by` its own parent, an epic closes only once its
 * children close, and the child is never claimable. So {@link checkTopology} tests `ref === epic`
 * ahead of the `external` arm.
 */

import {type Ref, readTopology} from "../build/dependencies.ts";

const LINE_RE = /^#(\d+)\s+phase\s+(\S+)(?:\s+requires\s+(.+))?$/i;
const REF_RE = /^#(\d+)$/;

export interface DeclaredLine {
	readonly child: number;
	readonly phase: number;
	readonly requires: ReadonlyArray<number>;
}

export type LineParse =
	| {readonly _tag: "Line"; readonly line: DeclaredLine}
	/** The line does not match the grammar at all — a `4`. */
	| {readonly _tag: "Unparseable"; readonly index: number; readonly text: string}
	/** The line parses and a value is off its closed vocabulary — a `10`. */
	| {readonly _tag: "OffVocabulary"; readonly phase: string};

/** Parse one stdin line. Blank lines are the caller's to drop before this is reached. */
export const parseLine = (text: string, index: number): LineParse => {
	const matched = LINE_RE.exec(text.trim());
	if (matched?.[1] === undefined || matched[2] === undefined) {
		return {_tag: "Unparseable", index, text: text.trim()};
	}
	if (!/^\d+$/.test(matched[2]) || Number.parseInt(matched[2], 10) < 1) {
		return {_tag: "OffVocabulary", phase: matched[2]};
	}
	const requires: number[] = [];
	for (const raw of (matched[3] ?? "").split(",")) {
		const part = raw.trim();
		if (part === "") continue;
		const ref = REF_RE.exec(part);
		if (ref?.[1] === undefined) return {_tag: "Unparseable", index, text: text.trim()};
		requires.push(Number.parseInt(ref[1], 10));
	}
	return {
		_tag: "Line",
		line: {
			child: Number.parseInt(matched[1], 10),
			phase: Number.parseInt(matched[2], 10),
			requires,
		},
	};
};

/**
 * What a body's `## Dependencies` block declares, read against the epic's live child set.
 *
 * `Absent` fuses two facts on purpose — no heading at all, and a heading under which no `phase` line
 * places anybody — because neither yields a topology and both take the same repair: plan the epic.
 *
 * `drop` is the axis `lane emit --children` and `ledger retopology` turn on, and it is the whole of
 * the descope story: off, the first ref the child set does not name is `Foreign` and the read stops
 * there; on, every such ref leaves its phase membership and every `requires` list naming it, a
 * `requires` line whose subject went is dropped whole, and the refs that went are reported in
 * `dropped` so a caller can say what the body still gets wrong.
 */
export type Declared =
	| {
			readonly _tag: "Declared";
			readonly lines: ReadonlyArray<DeclaredLine>;
			readonly dropped: ReadonlyArray<string>;
	  }
	| {readonly _tag: "Absent"}
	| {readonly _tag: "Unparseable"; readonly line: number; readonly text: string}
	| {readonly _tag: "Foreign"; readonly ref: string}
	| {readonly _tag: "Duplicate"; readonly child: number}
	| {readonly _tag: "Unplaced"; readonly child: number}
	/** Every ref the block placed was dropped — a surviving topology with no child in it. */
	| {readonly _tag: "Emptied"; readonly dropped: ReadonlyArray<string>};

type IssueRef = Extract<Ref, {_tag: "Issue"}>;

const refLabel = (ref: Ref): string => (ref._tag === "Issue" ? `#${ref.number}` : ref.id);

/** Read the block and restrict it to `children`. See {@link Declared} for what `drop` decides. */
export const readDeclared = (
	body: string,
	children: ReadonlySet<number>,
	drop: boolean,
): Declared => {
	const topo = readTopology(body);
	if (topo._tag === "Absent") return {_tag: "Absent"};
	if (topo._tag === "Unparseable") return {_tag: "Unparseable", line: topo.line, text: topo.text};

	const dropped: string[] = [];
	const known = (ref: Ref): ref is IssueRef => {
		if (ref._tag === "Issue" && children.has(ref.number)) return true;
		const label = refLabel(ref);
		if (!dropped.includes(label)) dropped.push(label);
		return false;
	};

	const phases = new Map<number, number[]>();
	const requires = new Map<number, number[]>();
	for (const edge of topo.edges) {
		if (!drop) {
			const refs = edge._tag === "Phase" ? edge.members : [edge.subject, ...edge.needs];
			for (const ref of refs) {
				if (ref._tag !== "Issue" || !children.has(ref.number)) {
					return {_tag: "Foreign", ref: refLabel(ref)};
				}
			}
		}
		if (edge._tag === "Phase") {
			const members = edge.members.filter(known).map((ref) => ref.number);
			phases.set(edge.phase, [...(phases.get(edge.phase) ?? []), ...members]);
			continue;
		}
		// The needs walk runs before the subject short-circuit because `known` is what records a
		// drop: returning early on a dropped subject would leave a ref that appears only in its
		// needs out of `dropped`, and the run would report fewer drops than it made.
		const subjectKnown = known(edge.subject);
		const needs = edge.needs.filter(known).map((ref) => ref.number);
		if (!subjectKnown) continue;
		const subject = edge.subject.number;
		requires.set(subject, [...(requires.get(subject) ?? []), ...needs]);
	}
	if (phases.size === 0) return {_tag: "Absent"};

	const placed = new Map<number, number>();
	for (const [phase, members] of phases) {
		for (const child of members) {
			if (placed.has(child)) return {_tag: "Duplicate", child};
			placed.set(child, phase);
		}
	}
	for (const [subject, needs] of requires) {
		for (const child of [subject, ...needs]) {
			if (!placed.has(child)) return {_tag: "Unplaced", child};
		}
	}
	if (placed.size === 0) return {_tag: "Emptied", dropped};

	const lines = [...placed.entries()].map(([child, phase]) => ({
		child,
		phase,
		requires: requires.get(child) ?? [],
	}));
	return {_tag: "Declared", lines, dropped};
};

/** `[dependent, prerequisite]` — the first entry requires the second. */
export type Edge = readonly [string, string];

const ascending = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
	[...values].sort((a, b) => a - b);

/** The block, in the grammar `build/dependencies.ts` reads: phase lines, then the `requires:` lines. */
export const renderDependencies = (lines: ReadonlyArray<DeclaredLine>): string => {
	const phases = [...new Set(lines.map((line) => line.phase))].sort((a, b) => a - b);
	const rows: string[] = ["## Dependencies", ""];
	for (const phase of phases) {
		const members = ascending(
			lines.filter((line) => line.phase === phase).map((line) => line.child),
		);
		rows.push(`- phase ${phase}: ${members.map((n) => `#${n}`).join(", ")}`);
	}
	for (const line of [...lines].sort((a, b) => a.child - b.child)) {
		if (line.requires.length === 0) continue;
		rows.push(
			`- #${line.child} requires: ${ascending(line.requires)
				.map((n) => `#${n}`)
				.join(", ")}`,
		);
	}
	// The trailing blank line keeps a later heading separated from the last row.
	return `${rows.join("\n")}\n`;
};

/** The canonical serialization both sides of the round trip are compared through. */
const canonical = (
	phases: ReadonlyMap<number, ReadonlyArray<number>>,
	requires: ReadonlyMap<number, ReadonlyArray<number>>,
): string =>
	[
		[...phases.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([phase, members]) => `p${phase}:${ascending(members).join(",")}`)
			.join(";"),
		[...requires.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([subject, needs]) => `${subject}>${ascending(needs).join(",")}`)
			.join(";"),
	].join("|");

const declaredCanonical = (lines: ReadonlyArray<DeclaredLine>): string => {
	const phases = new Map<number, number[]>();
	const requires = new Map<number, number[]>();
	for (const line of lines) {
		phases.set(line.phase, [...(phases.get(line.phase) ?? []), line.child]);
		if (line.requires.length > 0) requires.set(line.child, [...line.requires]);
	}
	return canonical(phases, requires);
};

/** The same serialization, taken over what the shipped parser read back out of the rendered block. */
const parsedCanonical = (block: string): string | null => {
	const parsed = readTopology(block);
	if (parsed._tag !== "Parsed") return null;
	const phases = new Map<number, number[]>();
	const requires = new Map<number, number[]>();
	for (const edge of parsed.edges) {
		if (edge._tag === "Phase") {
			const members: number[] = [];
			for (const ref of edge.members) {
				if (ref._tag !== "Issue") return null;
				members.push(ref.number);
			}
			phases.set(edge.phase, [...(phases.get(edge.phase) ?? []), ...members]);
			continue;
		}
		if (edge.subject._tag !== "Issue") return null;
		const needs: number[] = [];
		for (const ref of edge.needs) {
			if (ref._tag !== "Issue") return null;
			needs.push(ref.number);
		}
		requires.set(edge.subject.number, [...(requires.get(edge.subject.number) ?? []), ...needs]);
	}
	return canonical(phases, requires);
};

/** The union graph: `requires` edges plus the edges the phase order implies. */
const dependencyGraph = (
	lines: ReadonlyArray<DeclaredLine>,
): ReadonlyMap<number, ReadonlyArray<number>> => {
	const graph = new Map<number, number[]>();
	for (const line of lines) {
		const earlier = lines.filter((other) => other.phase < line.phase).map((other) => other.child);
		graph.set(line.child, [...new Set([...line.requires, ...earlier])]);
	}
	return graph;
};

/** The first cycle in the graph, as the ref path a refusal prints, or `null`. */
export const findCycle = (lines: ReadonlyArray<DeclaredLine>): ReadonlyArray<number> | null => {
	const graph = dependencyGraph(lines);
	const state = new Map<number, "open" | "done">();
	const stack: number[] = [];

	const walk = (node: number): ReadonlyArray<number> | null => {
		const seen = state.get(node);
		if (seen === "done") return null;
		if (seen === "open") return [...stack.slice(stack.indexOf(node)), node];
		state.set(node, "open");
		stack.push(node);
		for (const next of graph.get(node) ?? []) {
			const found = walk(next);
			if (found !== null) return found;
		}
		stack.pop();
		state.set(node, "done");
		return null;
	};

	for (const line of lines) {
		const found = walk(line.child);
		if (found !== null) return found;
	}
	return null;
};

export type TopologyCheck =
	| {
			readonly _tag: "Ok";
			readonly block: string;
			readonly phases: number;
			readonly edges: ReadonlyArray<Edge>;
			/**
			 * Every prerequisite number outside the run manifest, ascending — the set the verb must
			 * prove exists before it stages. Empty on a topology whose every edge stays inside the epic.
			 */
			readonly external: ReadonlyArray<number>;
	  }
	| {readonly _tag: "Invalid"; readonly reason: string};

const invalid = (reason: string): TopologyCheck => ({_tag: "Invalid", reason});

/**
 * Validate the declared lines against the run manifest's child set, then render and prove the round
 * trip.
 *
 * The manifest is the epic's **whole** child set, retained children included — which is what makes a
 * `re-plan` placeable. A manifest child with no line is an unplaced child, and a line whose *subject*
 * is not in the manifest places a stranger in one of this epic's phases; both are the same refusal,
 * because both produce a block the gate reads as a broken epic. A *prerequisite* outside the manifest
 * is neither — it is the cross-epic edge the decision corpus sanctions, and it rides out in `external`
 * unjudged, because whether it names a real issue is a question only the boundary can answer. The one
 * exception is the epic's own number, refused here rather than passed out.
 *
 * **That refusal reaches the immediate parent and stops there, by construction.** A grandparent epic
 * — or any other epic that transitively contains this child — can never clear either, but its number
 * is neither `epic` nor in `manifest`, so nothing here distinguishes it from the sanctioned cross-epic
 * prerequisite. Deciding it means walking the child's parent chain, which is a boundary read this
 * module cannot take.
 */
export const checkTopology = (
	epic: number,
	lines: ReadonlyArray<DeclaredLine>,
	manifest: ReadonlyArray<number>,
): TopologyCheck => {
	const counts = new Map<number, number>();
	for (const line of lines) counts.set(line.child, (counts.get(line.child) ?? 0) + 1);
	for (const [child, count] of counts) {
		if (count > 1) {
			return invalid(`#${child} is declared ${count} times — a child sits in exactly one phase.`);
		}
	}

	const known = new Set(manifest);
	const external = new Set<number>();
	for (const line of lines) {
		if (!known.has(line.child)) {
			return invalid(`#${line.child} is placed in a phase but is not a child of #${epic}.`);
		}
		for (const ref of line.requires) {
			if (ref === epic) {
				return invalid(
					`#${line.child} requires #${epic}, the epic that owns it — an epic closes only once its children close, so that edge can never clear and #${line.child} would never be claimable.`,
				);
			}
			if (!known.has(ref)) external.add(ref);
		}
	}
	for (const child of manifest) {
		if (!counts.has(child)) return invalid(`child #${child} is placed in no phase.`);
	}

	const cycle = findCycle(lines);
	if (cycle !== null) {
		return invalid(`cycle: ${cycle.map((n) => `#${n}`).join(" → ")}`);
	}

	const block = renderDependencies(lines);
	if (parsedCanonical(block) !== declaredCanonical(lines)) {
		return invalid(
			"the rendered block does not parse back to the declared edges — refusing to stage it.",
		);
	}

	const edges: Edge[] = [];
	for (const line of [...lines].sort((a, b) => a.child - b.child)) {
		for (const need of ascending(line.requires)) edges.push([`#${line.child}`, `#${need}`]);
	}
	return {
		_tag: "Ok",
		block,
		phases: new Set(lines.map((line) => line.phase)).size,
		edges,
		external: ascending([...external]),
	};
};
