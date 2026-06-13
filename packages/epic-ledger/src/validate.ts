/**
 * The deterministic structural floor: `validateLedger`, `isPickable`, and the
 * run-stable `ledgerSignature`.
 *
 * `validateLedger` is a pure `(EpicLedger) => readonly Defect[]` over the closed
 * 7-type enum. Determinism is the contract the downstream re-plan loop's stall
 * detection depends on, and it is enforced two ways: (1) every check derives its
 * findings from set membership and sorted issue numbers, never from the input's
 * presentation order; (2) the final defect list is sorted by canonical defect
 * rank then by the finding's first ref. So a permuted child array — or a
 * permuted `## Dependencies` listing — yields a byte-identical defect list and
 * an identical `ledgerSignature`. See `.claude/skills/gh-issue-intake-formats.md`
 * for the conventions each check enforces.
 */
import type {Defect, DefectType} from "./Defect.ts";
import {defectTypeRank} from "./Defect.ts";
import {findCycles} from "./graph.ts";
import type {EpicLedger} from "./Ledger.ts";

/**
 * The label categories a pickable child must carry exactly one of, in the order
 * a `MISSING_LABEL` finding reports them. `type:` and a priority bucket and a
 * `status:` are the floor; `triage`/`plan-epic` mint all three (a child born
 * from a planned epic is `type:* + p? + status:triaged`).
 */
const REQUIRED_LABEL_PREFIXES = ["type:", "status:"] as const;
const PRIORITY_LABELS = ["p0", "p1", "p2"] as const;
const NEEDS_TRIAGE_LABEL = "status:needs-triage";

const hasPrefixedLabel = (labels: ReadonlyArray<string>, prefix: string): boolean =>
	labels.some((l) => l.startsWith(prefix));

const hasPriorityLabel = (labels: ReadonlyArray<string>): boolean =>
	labels.some((l) => (PRIORITY_LABELS as ReadonlyArray<string>).includes(l));

/**
 * Validate a decoded ledger against the structural floor. Returns the canonical,
 * deterministically-ordered hard-defect set: empty for a clean ledger, otherwise
 * one `Defect` per finding, sorted by defect-type rank then issue ref.
 */
export const validateLedger = (ledger: EpicLedger): ReadonlyArray<Defect> => {
	const defects: Defect[] = [];
	const {epic, children} = ledger;
	const graph = epic.dependencies;

	const childNumbers = new Set(children.map((c) => c.number));
	const referenced = new Set(graph.nodes);

	if (!graph.present) {
		defects.push({
			type: "MISSING_DEPS_SECTION",
			message: `Epic #${epic.number} has no \`## Dependencies\` section.`,
			refs: [epic.number],
		});
	}

	for (const cycle of findCycles(graph.edges)) {
		defects.push({
			type: "DEP_CYCLE",
			message: `Dependency cycle: ${cycle.map((n) => `#${n}`).join(" → ")}.`,
			refs: cycle,
		});
	}

	const dangling = [...referenced]
		.filter((n) => n !== epic.number && !childNumbers.has(n))
		.sort((a, b) => a - b);
	for (const n of dangling) {
		defects.push({
			type: "DANGLING_DEP",
			message: `\`## Dependencies\` references #${n}, which is not a linked child of epic #${epic.number}.`,
			refs: [n],
		});
	}

	if (graph.present) {
		const orphans = children
			.filter((c) => !referenced.has(c.number))
			.map((c) => c.number)
			.sort((a, b) => a - b);
		for (const n of orphans) {
			defects.push({
				type: "ORPHAN_CHILD",
				message: `Child #${n} is not referenced in the \`## Dependencies\` section.`,
				refs: [n],
			});
		}
	}

	const covered = new Set<number>();
	for (const c of children) {
		for (const s of c.stories ?? []) covered.add(s);
	}
	const uncovered = [...new Set(epic.stories)].filter((s) => !covered.has(s)).sort((a, b) => a - b);
	for (const s of uncovered) {
		defects.push({
			type: "UNCOVERED_STORY",
			message: `User story ${s} declared by epic #${epic.number} is covered by no linked child.`,
			refs: [s],
		});
	}

	for (const child of [...children].sort((a, b) => a.number - b.number)) {
		if (child.acceptanceCriteriaCount < 1) {
			defects.push({
				type: "ZERO_AC",
				message: `Child #${child.number} has zero acceptance criteria.`,
				refs: [child.number],
			});
		}

		if (child.stories === undefined) {
			defects.push({
				type: "MISSING_STORY",
				message: `Child #${child.number} has no \`**Stories:**\` reference; every linked child must trace to ≥1 story.`,
				refs: [child.number],
			});
		}

		const missing: string[] = [];
		for (const prefix of REQUIRED_LABEL_PREFIXES) {
			if (!hasPrefixedLabel(child.labels, prefix)) missing.push(prefix);
		}
		if (!hasPriorityLabel(child.labels)) missing.push("priority");
		if (missing.length > 0) {
			defects.push({
				type: "MISSING_LABEL",
				message: `Child #${child.number} is missing required label(s): ${missing.join(", ")}.`,
				refs: [child.number],
			});
		}

		if (child.labels.includes(NEEDS_TRIAGE_LABEL)) {
			defects.push({
				type: "NEEDS_TRIAGE_LABEL",
				message: `Child #${child.number} still carries \`${NEEDS_TRIAGE_LABEL}\`; a planned child must not.`,
				refs: [child.number],
			});
		}
	}

	return defects.sort(
		(a, b) =>
			defectTypeRank(a.type) - defectTypeRank(b.type) || (a.refs[0] ?? 0) - (b.refs[0] ?? 0),
	);
};

/** A ledger is pickable iff the floor finds no hard defect. */
export const isPickable = (ledger: EpicLedger): boolean => validateLedger(ledger).length === 0;

const signatureToken = (type: DefectType, refs: ReadonlyArray<number>): string =>
	`${type}:${[...refs].sort((a, b) => a - b).join(".")}`;

/**
 * A run-stable fingerprint of a ledger's defect set — the type+refs of each
 * finding, in canonical order, joined. Two ledgers with the same defects (even
 * if their children or dependency lines were permuted) share a signature; the
 * re-plan loop compares signatures across iterations to detect a stall (the same
 * defect set recurred). The signature deliberately omits messages — a wording
 * change must not perturb stall detection.
 */
export const ledgerSignature = (ledger: EpicLedger): string => {
	const defects = validateLedger(ledger);
	if (defects.length === 0) return "clean";
	return defects.map((d) => signatureToken(d.type, d.refs)).join("|");
};
