/**
 * `intake-compose` core — the pure, IO-free composer for the **format-2 sub-issue
 * body** of the intake-formats prose contract (`gh-issue-intake-formats.md` §2).
 * One tested composer so the skills that file a sub-issue (plan-epic, and any future
 * filer) stop re-deriving the format by hand — the #3254 "cite the verb, don't
 * re-derive" rule (epic #3258).
 *
 * `composeSubIssueBody` returns the body **by value** — never a file path — which is
 * what makes the caller's handoff leak-safe; that design and its rationale live at
 * the one site that enforces it, the stdout-only CLI in `command.ts`.
 *
 * `validateSubIssueSpec` enforces the format-2 invariants (contract §2) — non-empty
 * `Stories` / `What to build`, a `yes|no` TDD flag, and the ≥ 1-acceptance-criterion
 * hard floor — separately from composition so both are pure and unit-testable.
 */

/** The `**TDD:**` flag values the format-2 header admits. */
export type TddFlag = "yes" | "no";

/** The structured inputs a format-2 sub-issue body is composed from (contract §2 Shape). */
export interface SubIssueSpec {
	/** `**Stories:**` — bare story back-references, or the `none (pure infra …)` marker. Required, non-empty. */
	readonly stories: string;
	/** `**TDD:**` — test-first advice to write-code. */
	readonly tdd: TddFlag;
	/**
	 * `**Containment:**` — the per-child cycle-containment marker. Omitted when the
	 * child needs none; a missing line reads as `none` per the contract's tolerant read.
	 */
	readonly containment?: string;
	/** `### What to build` — the prose spec. Required, non-empty. */
	readonly whatToBuild: string;
	/** `### Acceptance criteria` — the checklist review-code verifies. The hard floor: ≥ 1. */
	readonly acceptanceCriteria: ReadonlyArray<string>;
}

/**
 * Validate the format-2 invariants (contract §2). Returns the list of violation
 * messages — an empty list means the spec is well-formed. Pure: no IO, no throw.
 */
export const validateSubIssueSpec = (spec: SubIssueSpec): ReadonlyArray<string> => {
	const violations: string[] = [];
	if (spec.stories.trim() === "") {
		violations.push(
			"`Stories` is required — a bare story back-reference, or `none (pure infra — see What to build)`",
		);
	}
	if (spec.tdd !== "yes" && spec.tdd !== "no") {
		violations.push("`TDD` must be `yes` or `no`");
	}
	if (spec.whatToBuild.trim() === "") {
		violations.push("`What to build` is required — the prose spec cannot be empty");
	}
	// The contract's hard floor: a body with zero acceptance criteria is malformed —
	// write-code has no "done" and review-code has nothing to verify (contract §2 Invariant).
	const criteria = spec.acceptanceCriteria.filter((c) => c.trim() !== "");
	if (criteria.length === 0) {
		violations.push(
			"at least one non-empty acceptance criterion is required (contract §2 hard floor)",
		);
	}
	return violations;
};

/**
 * Compose the format-2 sub-issue body from a validated spec — deterministic and
 * total. Header lines (`Stories` / `TDD` / optional `Containment`) are consecutive,
 * then the `### What to build` and `### Acceptance criteria` sections, each
 * criterion an unchecked checkbox bullet. Trailing whitespace is trimmed so the
 * output is byte-stable for a given spec.
 *
 * Callers should run `validateSubIssueSpec` first; composition itself is total and
 * will emit whatever it is handed (an empty criteria list yields no bullets), which
 * is why the invariant check is the caller's gate, not a silent drop here.
 */
export const composeSubIssueBody = (spec: SubIssueSpec): string => {
	const header = [`**Stories:** ${spec.stories.trim()}`, `**TDD:** ${spec.tdd}`];
	if (spec.containment !== undefined && spec.containment.trim() !== "") {
		header.push(`**Containment:** ${spec.containment.trim()}`);
	}

	const criteria = spec.acceptanceCriteria
		.map((c) => c.trim())
		.filter((c) => c !== "")
		.map((c) => `- [ ] ${c}`);

	const sections = [
		header.join("\n"),
		"",
		"### What to build",
		spec.whatToBuild.trim(),
		"",
		"### Acceptance criteria",
		criteria.join("\n"),
	];

	return `${sections.join("\n")}\n`;
};
