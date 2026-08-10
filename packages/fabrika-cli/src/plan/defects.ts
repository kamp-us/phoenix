/**
 * The floor: a total function from the ledger to a sorted defect list over a closed thirteen-type
 * enum. `plan check` is this function plus a fetch; nothing above it can change the answer.
 *
 * **Fourteen names, thirteen defects.** `ZERO_SCOPE` is the fourteenth and is seated as exit `7`
 * rather than as defect zero: v1 made a childless epic defect #1 and early-returned, so the ledger
 * was never validated and the verdict reported exactly one thing wrong about a plan it had not read.
 * A refused scope is not a defect list of length one (ADR 0092).
 *
 * **A class that cannot be derived is named, never dropped.** `MISSING_CONTAINMENT` rests on a
 * three-valued probe: `present` derives the class, `absent` derives it and evaluates it false, and
 * only `unknown` puts it in {@link Floor.skipped}. v1 fused `absent` and `unknown` through a stderr
 * substring match, so a transient probe failure silently switched the whole class off for a run.
 *
 * The priority set is exactly `{p0, p1, p2}` — `p3` was ruled *retired*, not widened (#4101, #2413).
 */

import type {LedgerScope} from "./digest.ts";
import type {ChildLedger} from "./model.ts";

/** The emission order, which is also the primary sort key. */
export const DEFECT_TYPES = [
	"MISSING_DEPS_SECTION",
	"DEP_CYCLE",
	"DANGLING_DEP",
	"ORPHAN_CHILD",
	"MISSING_STORIES_SECTION",
	"UNCOVERED_STORY",
	"ZERO_AC",
	"MISSING_STORY",
	"MISSING_LABEL",
	"MISSING_CONTAINMENT",
	"NEEDS_TRIAGE_LABEL",
	"UNVERIFIABLE_ASSIGNEE",
	"HELD_CHILD_UNASSIGNED",
] as const;

export type DefectType = (typeof DEFECT_TYPES)[number];

export interface Defect {
	readonly type: DefectType;
	readonly refs: ReadonlyArray<number>;
	/** A fixed template per type, never free prose. */
	readonly detail: string;
}

export interface Floor {
	readonly defects: ReadonlyArray<Defect>;
	/** Classes not derived and therefore not asked. A skipped class never makes the floor clean. */
	readonly skipped: ReadonlyArray<DefectType>;
}

export const PRIORITY_LABELS: ReadonlyArray<string> = ["p0", "p1", "p2"];
export const HELD_LABEL = "ready-for:human";
export const NEEDS_TRIAGE_LABEL = "status:needs-triage";

const issueNumber = (ref: string): number | null => {
	const matched = /^#(\d+)$/.exec(ref);
	return matched?.[1] === undefined ? null : Number.parseInt(matched[1], 10);
};

/** Every issue ref the topology names, deduped and ascending. Ledger-local `C<n>` ids are not issues. */
export const referencedIssues = (ledger: LedgerScope): ReadonlyArray<number> => {
	const refs = new Set<number>();
	for (const phase of ledger.topology.phases) {
		for (const member of phase.members) {
			const number = issueNumber(member);
			if (number !== null) refs.add(number);
		}
	}
	for (const [dependent, prerequisite] of ledger.topology.edges) {
		for (const ref of [dependent, prerequisite]) {
			const number = issueNumber(ref);
			if (number !== null) refs.add(number);
		}
	}
	return [...refs].sort((a, b) => a - b);
};

/**
 * The refs `DANGLING_DEP` must probe: everything the topology names that is neither the epic nor one
 * of its children. The probe itself belongs to the verb; this keeps the *set* derivable and testable.
 */
export const refsToProbe = (ledger: LedgerScope): ReadonlyArray<number> => {
	const children = new Set(ledger.children.map((child) => child.number));
	return referencedIssues(ledger).filter((ref) => ref !== ledger.epic && !children.has(ref));
};

/**
 * The cycles among the topology's edges, each as its sorted member set.
 *
 * Tarjan's strongly-connected components: any component of more than one node is a cycle, and a
 * self-loop is one of size one. Walking components rather than paths is what makes the answer
 * deduped and order-independent — two edges reported in either order name the same cycle once.
 */
const cycles = (
	edges: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<ReadonlyArray<string>> => {
	const adjacency = new Map<string, string[]>();
	const nodes = new Set<string>();
	for (const [dependent, prerequisite] of edges) {
		nodes.add(dependent);
		nodes.add(prerequisite);
		const out = adjacency.get(dependent);
		if (out === undefined) adjacency.set(dependent, [prerequisite]);
		else out.push(prerequisite);
	}

	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const onStack = new Set<string>();
	const stack: string[] = [];
	const found: string[][] = [];
	let next = 0;

	const strongConnect = (node: string): void => {
		index.set(node, next);
		low.set(node, next);
		next += 1;
		stack.push(node);
		onStack.add(node);
		for (const target of adjacency.get(node) ?? []) {
			if (!index.has(target)) {
				strongConnect(target);
				low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0));
			} else if (onStack.has(target)) {
				low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0));
			}
		}
		if (low.get(node) !== index.get(node)) return;
		const component: string[] = [];
		for (;;) {
			const popped = stack.pop();
			if (popped === undefined) break;
			onStack.delete(popped);
			component.push(popped);
			if (popped === node) break;
		}
		const selfLoop = (adjacency.get(node) ?? []).includes(node);
		if (component.length > 1 || selfLoop) found.push(component.sort());
	};

	for (const node of [...nodes].sort()) if (!index.has(node)) strongConnect(node);
	return found.sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
};

const criteriaReading = (child: ChildLedger): "absent" | "malformed" | "empty" | null => {
	if (child.criteria === "absent") return "absent";
	if (child.criteria === "malformed") return "malformed";
	return child.criteriaCount === 0 ? "empty" : null;
};

const appearsInTopology = (ledger: LedgerScope, child: number): boolean => {
	const ref = `#${child}`;
	return (
		ledger.topology.phases.some((phase) => phase.members.includes(ref)) ||
		ledger.topology.edges.some(
			([dependent, prerequisite]) => dependent === ref || prerequisite === ref,
		)
	);
};

const missingLabelKinds = (labels: ReadonlyArray<string>): ReadonlyArray<string> => {
	const missing: string[] = [];
	if (!labels.some((label) => label.startsWith("type:"))) missing.push("type:");
	if (!labels.some((label) => label.startsWith("status:"))) missing.push("status:");
	if (!labels.some((label) => PRIORITY_LABELS.includes(label))) missing.push("priority");
	return missing;
};

export interface FloorInput {
	readonly ledger: LedgerScope;
	/** The refs {@link refsToProbe} named that a 404-discriminating probe proved **absent**. */
	readonly provenAbsent: ReadonlySet<number>;
}

export const deriveFloor = ({ledger, provenAbsent}: FloorInput): Floor => {
	const defects: Defect[] = [];

	if (ledger.dependenciesAbsent) {
		defects.push({
			type: "MISSING_DEPS_SECTION",
			refs: [ledger.epic],
			detail: "no ## Dependencies section",
		});
	}

	for (const members of cycles(ledger.topology.edges)) {
		const refs = members.map(issueNumber).filter((n): n is number => n !== null);
		defects.push({
			type: "DEP_CYCLE",
			refs: [...refs].sort((a, b) => a - b),
			detail: `cycle: ${[...members, members[0] ?? ""].join(" → ")}`,
		});
	}

	for (const ref of refsToProbe(ledger)) {
		if (!provenAbsent.has(ref)) continue;
		defects.push({
			type: "DANGLING_DEP",
			refs: [ref],
			detail: `#${ref} is referenced but is not a child and is proven absent`,
		});
	}

	if (!ledger.dependenciesAbsent) {
		for (const child of ledger.children) {
			if (appearsInTopology(ledger, child.number)) continue;
			defects.push({
				type: "ORPHAN_CHILD",
				refs: [child.number],
				detail: `#${child.number} appears in no phase or requires line`,
			});
		}
	}

	if (ledger.epicStories.length === 0) {
		defects.push({
			type: "MISSING_STORIES_SECTION",
			refs: [ledger.epic],
			detail: "the epic declares no user stories",
		});
	}

	const claimed = new Set(ledger.children.flatMap((child) => [...(child.stories ?? [])]));
	for (const story of ledger.epicStories) {
		if (claimed.has(story)) continue;
		defects.push({
			type: "UNCOVERED_STORY",
			refs: [ledger.epic],
			detail: `story ${story} is claimed by no child`,
		});
	}

	for (const child of ledger.children) {
		const reading = criteriaReading(child);
		if (reading !== null) {
			defects.push({
				type: "ZERO_AC",
				refs: [child.number],
				detail: `acceptance criteria read as ${reading}`,
			});
		}

		if (ledger.epicStories.length > 0 && child.stories === null) {
			defects.push({
				type: "MISSING_STORY",
				refs: [child.number],
				detail:
					child.storiesValue === null
						? "no **Stories:** line"
						: `**Stories:** value does not conform: "${child.storiesValue}"`,
			});
		}

		for (const kind of missingLabelKinds(child.labels)) {
			defects.push({
				type: "MISSING_LABEL",
				refs: [child.number],
				detail: `missing a ${kind} label`,
			});
		}

		if (
			ledger.cycleDoc === "present" &&
			child.labels.includes("type:feature") &&
			(child.containment === null || child.containment === "none")
		) {
			defects.push({
				type: "MISSING_CONTAINMENT",
				refs: [child.number],
				detail: `type:feature with containment ${child.containment === null ? "unset" : "none"}`,
			});
		}

		if (child.labels.includes(NEEDS_TRIAGE_LABEL)) {
			defects.push({
				type: "NEEDS_TRIAGE_LABEL",
				refs: [child.number],
				detail: `still carries ${NEEDS_TRIAGE_LABEL}`,
			});
		}

		if (!child.assigneesObserved) {
			defects.push({
				type: "UNVERIFIABLE_ASSIGNEE",
				refs: [child.number],
				detail: "the assignees field was not observed",
			});
		}

		if (
			child.labels.includes(HELD_LABEL) &&
			child.assigneesObserved &&
			(child.assignees ?? []).length === 0
		) {
			defects.push({
				type: "HELD_CHILD_UNASSIGNED",
				refs: [child.number],
				detail: `${HELD_LABEL} with an empty assignee slot`,
			});
		}
	}

	const rank = (type: DefectType): number => DEFECT_TYPES.indexOf(type);
	const sorted = [...defects].sort((a, b) => {
		if (a.type !== b.type) return rank(a.type) - rank(b.type);
		const lowest = (d: Defect): number => d.refs[0] ?? Number.MAX_SAFE_INTEGER;
		return lowest(a) === lowest(b) ? a.detail.localeCompare(b.detail) : lowest(a) - lowest(b);
	});

	return {
		defects: sorted,
		skipped: ledger.cycleDoc === "unknown" ? ["MISSING_CONTAINMENT"] : [],
	};
};
