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
 */

import {readTopology} from "../build/dependencies.ts";

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

/** `[dependent, prerequisite]` — `["#4303","#4301"]` reads *#4303 requires #4301*. */
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
	  }
	| {readonly _tag: "Invalid"; readonly reason: string};

const invalid = (reason: string): TopologyCheck => ({_tag: "Invalid", reason});

/**
 * Validate the declared lines against the run manifest's child set, then render and prove the round
 * trip.
 *
 * The manifest is the epic's **whole** child set, retained children included — which is what makes a
 * `re-plan` placeable. A manifest child with no line is an unplaced child; a line naming a number that
 * is not in the manifest is a dangling reference. Both are the same refusal, because both produce a
 * block the gate reads as a broken epic.
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
	for (const line of lines) {
		for (const ref of [line.child, ...line.requires]) {
			if (!known.has(ref)) return invalid(`#${ref} is referenced but is not a child of #${epic}.`);
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
	};
};
