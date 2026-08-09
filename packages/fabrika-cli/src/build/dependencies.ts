/**
 * The `## Dependencies` grammar — canonical here, consumed by `build eligible` and validated by
 * `build check --surface plan`.
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
const PHASE_RE = /^-\s*phase\s+(\d+)\s*:\s*(.+)$/i;
const REQUIRES_RE = /^-\s*(\S+)\s+requires\s*:\s*(.+)$/i;

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
		if (ANY_HEADING_RE.test(text)) break;

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
