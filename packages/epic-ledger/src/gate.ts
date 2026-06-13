/**
 * The deterministic `review-plan` gate action (ADR 0047, issue #164).
 *
 * Given an epic number: fetch its `EpicLedger` through the `Github` capability,
 * run `validateLedger`, and branch on the hard-defect set:
 *
 *   - **zero defects** → flip every `status:planned` child to `status:triaged`
 *     (the children become pickable by `write-code`) and post a PASS verdict;
 *   - **≥1 defect** → post a per-defect FAIL verdict and flip **nothing**.
 *
 * The action mutates only child labels (on a pass) and its own verdict comment —
 * never the brief, the topology, or the sub-issue links (Decision 1 + "Banned"
 * in ADR 0047). It is flag-not-repair: it signals; the re-plan loop (#166) owns
 * any repair. The returned `GateVerdict` is the structured result the loop reads
 * to decide whether to converge, re-plan, or park.
 */
import {Effect} from "effect";
import type * as Schema from "effect/Schema";
import type {Defect} from "./Defect.ts";
import type {GhCommandError, GhParseError} from "./github.ts";
import {Github} from "./github.ts";
import type {EpicLedger} from "./Ledger.ts";
import {ledgerSignature, validateLedger} from "./validate.ts";

const PLANNED_LABEL = "status:planned";

/** A child the gate flipped (it carried `status:planned` and passed the floor). */
const plannedChildren = (ledger: EpicLedger): ReadonlyArray<number> =>
	ledger.children.filter((c) => c.labels.includes(PLANNED_LABEL)).map((c) => c.number);

/**
 * The outcome of one gate pass. `"pass"` carries the children it flipped (the
 * `status:planned → status:triaged` set); `"fail"` carries the canonical defect
 * set and its run-stable `signature` — the two facts the re-plan loop compares
 * across iterations to detect a stall (#166). `signature` is `ledgerSignature`
 * over the same ledger, so a `"fail"` verdict is self-describing for the loop.
 */
export type GateVerdict =
	| {readonly _tag: "pass"; readonly epicNumber: number; readonly flipped: ReadonlyArray<number>}
	| {
			readonly _tag: "fail";
			readonly epicNumber: number;
			readonly defects: ReadonlyArray<Defect>;
			readonly signature: string;
	  };

const PASS_MARKER = "review-plan: PASS — children flipped to status:triaged";
const FAIL_MARKER = "review-plan: FAIL — ledger has hard defects";

const passVerdict = (epicNumber: number, flipped: ReadonlyArray<number>): string => {
	const list =
		flipped.length === 0
			? "_No `status:planned` child remained to flip (already triaged)._"
			: flipped.map((n) => `- #${n} \`status:planned\` → \`status:triaged\``).join("\n");
	return [
		`**${PASS_MARKER}**`,
		"",
		`Epic #${epicNumber}'s ledger passed the deterministic structural floor (zero hard defects).`,
		"The following children are now pickable by `write-code`:",
		"",
		list,
	].join("\n");
};

const failVerdict = (epicNumber: number, defects: ReadonlyArray<Defect>): string => {
	const rows = defects
		.map((d) => `- \`${d.type}\` (${d.refs.map((n) => `#${n}`).join(", ")}) — ${d.message}`)
		.join("\n");
	return [
		`**${FAIL_MARKER}**`,
		"",
		`Epic #${epicNumber}'s ledger has ${defects.length} hard defect(s); no child was flipped.`,
		"Each must be resolved before the gate can flip `status:planned → status:triaged`:",
		"",
		rows,
	].join("\n");
};

/**
 * Run the deterministic gate over an epic. Returns the structured `GateVerdict`;
 * the label flips and the verdict comment are its only side effects. Fails only
 * with the `Github` capability's typed errors (a `gh` infra failure, malformed
 * `gh` JSON, or a structurally-invalid REST shape) — never a throw.
 */
export const runGate = Effect.fn("ReviewPlan.runGate")(function* (epicNumber: number) {
	const github = yield* Github;
	const ledger = yield* github.epicLedger(epicNumber);
	const defects = validateLedger(ledger);

	if (defects.length === 0) {
		const flipped = plannedChildren(ledger);
		yield* Effect.forEach(flipped, (child) => github.flipChildToTriaged(child), {
			concurrency: "unbounded",
			discard: true,
		});
		yield* github.postComment(epicNumber, passVerdict(epicNumber, flipped));
		return {_tag: "pass", epicNumber, flipped} satisfies GateVerdict;
	}

	yield* github.postComment(epicNumber, failVerdict(epicNumber, defects));
	return {
		_tag: "fail",
		epicNumber,
		defects,
		signature: ledgerSignature(ledger),
	} satisfies GateVerdict;
});

/** The markers a verdict comment leads with — the skill and the loop key on these. */
export const VERDICT_MARKERS = {pass: PASS_MARKER, fail: FAIL_MARKER} as const;

/** The gate's failure surface: a `gh` infra fault, malformed JSON, or a bad REST shape. */
export type GateError = GhCommandError | GhParseError | Schema.SchemaError;
