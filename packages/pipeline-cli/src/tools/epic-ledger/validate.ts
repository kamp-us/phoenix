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
 * from a planned epic is `type:* + p? + status:planned`, which `review-plan`
 * later flips to `status:triaged` — see ADR 0047).
 */
const REQUIRED_LABEL_PREFIXES = ["type:", "status:"] as const;
const PRIORITY_LABELS = ["p0", "p1", "p2"] as const;
const NEEDS_TRIAGE_LABEL = "status:needs-triage";
const FEATURE_LABEL = "type:feature";

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

	// Zero-scope=fail self-assertion (formats §ZS / ADR 0092): the floor's scope IS the
	// children it scans, so an epic that declares none gave it nothing to validate. Fail
	// closed with a single root-cause finding rather than reading a silent clean PASS — every
	// per-child check below is vacuous on zero children, so it would otherwise pass empty.
	if (children.length === 0) {
		return [
			{
				type: "ZERO_SCOPE",
				message: `Epic #${epic.number} declares no linked children; the floor scanned zero scope (a gate that scans nothing fails closed — ADR 0092).`,
				refs: [epic.number],
			},
		];
	}

	const childNumbers = new Set(children.map((c) => c.number));
	const referenced = new Set(graph.nodes);
	const external = new Set(ledger.externalRefs);

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
		.filter((n) => n !== epic.number && !childNumbers.has(n) && !external.has(n))
		.sort((a, b) => a - b);
	for (const n of dangling) {
		defects.push({
			type: "DANGLING_DEP",
			message: `\`## Dependencies\` references #${n}, which is neither a linked child of epic #${epic.number} nor a resolvable cross-epic issue.`,
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

	// An epic that declares no `### User stories` at all is malformed at the epic
	// level (the story-side mirror of MISSING_DEPS_SECTION). When this fires, the
	// per-child MISSING_STORY below is suppressed — the children have no stories to
	// trace to, so the single epic-level defect is the legible root cause.
	const epicDeclaresStories = epic.stories.length > 0;
	if (!epicDeclaresStories) {
		defects.push({
			type: "MISSING_STORIES_SECTION",
			message: `Epic #${epic.number} declares no \`### User stories\`; a PRD-grade epic must (its children have no stories to trace to).`,
			refs: [epic.number],
		});
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

		if (epicDeclaresStories && child.stories === undefined) {
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

		// ADR 0091 forcing function: in a repo with a cycle doc, every `type:feature`
		// child must carry a `flag (default-off)` | `exempt (<reason>)` containment
		// marker. A missing line decodes to `undefined`, read identically to `"none"`
		// per the formats §2 tolerant-read rule — both are the unset state. Only
		// `type:feature` is gated (a non-feature child has no user-facing surface to
		// contain); without a cycle doc `none` is the valid graceful-absence value, so
		// the check is a no-op (cycleDocPresent === false).
		if (
			ledger.cycleDocPresent &&
			child.labels.includes(FEATURE_LABEL) &&
			(child.containment === undefined || child.containment === "none")
		) {
			defects.push({
				type: "MISSING_CONTAINMENT",
				message: `Child #${child.number} is \`type:feature\` but carries no \`**Containment:**\` marker; every feature child must declare \`flag (default-off)\` or \`exempt (<reason>)\` (ADR 0091).`,
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
