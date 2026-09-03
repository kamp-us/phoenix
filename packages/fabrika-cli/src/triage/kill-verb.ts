/**
 * `triage kill` — close an agent-filed issue not-planned, auditably.
 *
 * This is the group's only irreversible act on a public board, which shapes every decision below:
 * no precondition resolves to a plausible value, and no write runs before all of them are proven.
 *
 * **Two guards, and they are different guards (ADR 0159, as narrowed by the #4619 and #6070
 * rulings).** A filing with no agent signal — no footer *and* no operator author — is human-owned
 * and the verb refuses outright, *unless* `--duplicate-of` names a survivor: a fold moves the
 * content rather than discarding it, so #6070 licensed it whatever the provenance (ADR 0181's
 * 2026-08-21 amendment). An agent signal makes a filing *eligible*, not closeable — a human-invoked
 * `/report` emits the same footer, so `--confirm` is the confirmation step made
 * structural. That is why `--confirm` is optional at the parser and refused at the verb: a
 * parser-required flag's absence is a usage error, indistinguishable from a typo, while ADR 0159's
 * confirmation is a decision whose absence must be a proven refusal a caller can read as one.
 *
 * **Write order is the auditability guarantee.** Fold the duplicate content, post the reason, write
 * the labels — every triage status stripped through `./facets.ts`'s reconcile, `closed-by-triage`
 * applied — then close, and each step gates the next, so a failure before the close leaves the issue
 * OPEN, which is the recoverable direction. The three unguarded sequential writes this replaces
 * landed a closed, unexplained, unlabelled issue whenever the middle one failed.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	closeNotPlanned,
	createComment,
	getIssue,
	type IssueRecord,
	listLabels,
	resolveRepo,
} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {scanBody} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {type AuthoredSurface, leakRefusal, readAuthored} from "./authored.ts";
import {
	HUMAN_FILED,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UNCONFIRMED,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {applyChanges} from "./facet-writes.ts";
import {type Change, killedFacets, planReconcile, renderShape, shapeViolations} from "./facets.ts";
import {OPERATOR_ACCOUNTS_ENV, provenanceOf, resolveOperatorAccounts} from "./provenance.ts";
import {scannedLine} from "./scope.ts";
import {guardTarget} from "./target-guard.ts";

/** The label a kill is audited by. Its absence in the repo is a zero-scope refusal, not a create. */
export const KILL_LABEL = "closed-by-triage";

const SURFACE: AuthoredSurface = {
	verb: "triage kill",
	noun: "the reason",
	emptyHint: "refusing an unauditable kill: pipe the reason in.",
};

export interface KillOptions {
	readonly issue: number;
	/** ADR 0159's confirmation. Absent ⇒ a proven refusal on `13`, never a usage error. */
	readonly confirm: boolean;
	readonly duplicateOf: number | null;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The claim token `triage claim` handed this lane — which lane of the session is asking. */
	readonly token: string | null;
	readonly stdin: Effect.Effect<StdinRead>;
}

const isIssueNumber = (n: number): boolean => Number.isInteger(n) && n > 0;

export const runKill = (
	options: KillOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {issue, duplicateOf, json} = options;

		if (!isIssueNumber(issue)) {
			return refuse(FAILED, `triage kill: ${issue} is not an issue number.`);
		}
		if (duplicateOf !== null && !isIssueNumber(duplicateOf)) {
			return refuse(FAILED, `triage kill: --duplicate-of ${duplicateOf} is not an issue number.`);
		}
		if (duplicateOf === issue) {
			return refuse(
				FAILED,
				`triage kill: --duplicate-of #${issue} is the issue being killed — refusing to fold it into itself.`,
			);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"triage kill: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;
		const reason = authored.text;

		// The reason is posted verbatim, so scanning it here is scanning the composed body.
		const leaked = leakRefusal(SURFACE, reason);
		if (leaked !== null) return leaked;

		const target = yield* getIssue(repo, issue);
		if (target._tag === "Absent") {
			return refuse(ZERO_SCOPE, `triage kill: issue #${issue} not found in ${repo}.`);
		}
		if (target._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`triage kill: cannot read #${issue} in ${repo}: ${target.reason} — the provenance test has no evidence; refusing to close on a body that was never read.`,
			);
		}
		const guarded = yield* guardTarget({
			verb: "triage kill",
			repo,
			issue,
			target: target.value,
			env: options.env,
			token: options.token,
		});
		if (guarded !== null) return guarded;

		const operators = resolveOperatorAccounts(options.env);
		const provenance = provenanceOf(target.value, operators);

		// Only worth saying when emptiness is what decided the answer; an operator-authored filing is
		// agent-reported however little its body says, so the fail-closed line would misreport it.
		const emptyBodyNotice =
			target.value.body.trim() === "" && provenance === "human"
				? [
						`triage kill: #${issue} has an empty body — reading its provenance as human (fail-closed).`,
					]
				: [];

		// The fold exception is conditional, never merely later: gating on `duplicateOf` here keeps
		// `12` ahead of `13` on every non-fold path, which moving this test below `--confirm` would
		// silently swap.
		if (provenance === "human" && duplicateOf === null) {
			// An unset operator set makes every footerless filing read human, including the operator's
			// own — the refusal is correct but its cause is invisible, so name the config that decides it.
			const unconfiguredNotice =
				operators.size === 0
					? [
							`triage kill: no operator accounts are configured (${OPERATOR_ACCOUNTS_ENV} is unset), so a footerless filing reads human whoever authored it.`,
						]
					: [];
			return refuse(
				HUMAN_FILED,
				`triage kill: #${issue} is human-filed — refusing to close it. Park it with questions instead.`,
				[...emptyBodyNotice, ...unconfiguredNotice],
			);
		}

		if (!options.confirm) {
			const standing =
				provenance === "human"
					? `is human-filed and would be folded into #${duplicateOf}`
					: "is agent-filed and close-eligible";
			return refuse(
				UNCONFIRMED,
				`triage kill: #${issue} ${standing}, but ADR 0159 makes the confirmation the guard — pass --confirm once salvage has genuinely been attempted.`,
			);
		}

		let duplicate: IssueRecord | null = null;
		if (duplicateOf !== null) {
			const found = yield* getIssue(repo, duplicateOf);
			if (found._tag === "Absent") {
				return refuse(
					ZERO_SCOPE,
					`triage kill: --duplicate-of #${duplicateOf} not found in ${repo}.`,
				);
			}
			if (found._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`triage kill: cannot read --duplicate-of #${duplicateOf} in ${repo}: ${found.reason} — no kill was attempted.`,
				);
			}
			if (found.value.state === "closed") {
				return refuse(
					ZERO_SCOPE,
					`triage kill: --duplicate-of #${duplicateOf} is closed — refusing to fold this issue's content into a closed issue where nobody will read it.`,
				);
			}
			duplicate = found.value;
		}

		const labels = yield* listLabels(repo);
		if (labels._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`triage kill: cannot read the label set of ${repo}: ${labels.reason} — no kill was attempted.`,
			);
		}
		const scope = scannedLine("triage kill", repo, labels.value.length, "label");
		if (!labels.value.includes(KILL_LABEL)) {
			return refuse(
				ZERO_SCOPE,
				`triage kill: label ${KILL_LABEL} does not exist in ${repo} — refusing a kill that would be invisible to the audit.`,
				[scope, ...emptyBodyNotice],
			);
		}

		// The duplicate's body is foreign content being preserved, so it is redacted rather than
		// refused — the asymmetry `./authored.ts` states.
		const foldScan = scanBody(target.value.body);
		const redactions = duplicate === null ? 0 : foldScan.leaks.length;
		const redactionNotice =
			redactions === 0
				? []
				: [
						`triage kill: redacted ${redactions} machine-local path(s) from the folded duplicate body.`,
					];
		const diagnostics = [scope, ...emptyBodyNotice, ...redactionNotice];

		// Each write gates the next, and each `8` names what landed, what did not, and the recovery —
		// because "nothing happened, re-run" and "three comments are live, re-running duplicates them"
		// are opposite instructions.
		if (duplicate !== null) {
			const foldBody = `Folded from #${issue} (closed not-planned as a duplicate of this issue).\n\n${foldScan.redacted}`;
			const folded = yield* createComment(repo, duplicate.number, foldBody);
			if (folded._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`triage kill: the fold comment on #${duplicate.number} failed: ${folded.reason} — #${issue} is NOT closed, carries no reason and no label; nothing was lost. Re-run.`,
					diagnostics,
				);
			}
		}

		const reasonComment = yield* createComment(repo, issue, reason);
		if (reasonComment._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				duplicate === null
					? `triage kill: the reason comment on #${issue} failed: ${reasonComment.reason} — #${issue} is NOT closed and carries no label; nothing landed and nothing was lost. Re-run.`
					: `triage kill: the reason comment on #${issue} failed: ${reasonComment.reason} — #${issue} is NOT closed and carries no label, but the fold on #${duplicate.number} DID land; delete that comment before re-running, or the fold posts twice.`,
				diagnostics,
			);
		}

		// The strip rides in the label step rather than after the close, which is what keeps the write
		// order's guarantee intact: a failure here leaves the issue OPEN, the recoverable direction.
		// The removals are planned by the shared engine off `killedFacets`, so the kill exit and the
		// two reconciling exits cannot disagree about which statuses a triage transition owns (#6710).
		const facets = killedFacets();
		const home = target.value.milestone;
		const plan = planReconcile({labels: target.value.labels, milestone: home}, facets, home);
		const labelChanges: ReadonlyArray<Change> = [
			...plan.changes,
			{_tag: "AddLabels", labels: [KILL_LABEL]},
		];

		const labelled = yield* applyChanges(repo, issue, labelChanges);
		if (labelled._tag === "Failed") {
			return refuse(
				WRITE_UNKNOWN,
				`triage kill: the label step on #${issue} failed after ${labelled.applied} of ${labelChanges.length} change(s): ${labelled.reason} — the fold and the reason comment landed; #${issue} is still OPEN and invisible to the kill audit. Apply ${KILL_LABEL} by hand and strip any triage status label, or delete the landed comments and re-run.`,
				diagnostics,
			);
		}

		const closed = yield* closeNotPlanned(repo, issue);
		if (closed._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`triage kill: closing #${issue} failed: ${closed.reason} — the fold, the reason and ${KILL_LABEL} all landed; #${issue} is still OPEN and fully annotated. Close it by hand with state_reason=not_planned, or delete the landed comments and re-run.`,
				diagnostics,
			);
		}

		// A plain `closed` reads as "done", not "killed", so the read-back asserts BOTH fields. An
		// unreadable read-back is not a proven close either: the writes landed and the outcome is
		// unverified, which is exactly what `9` says.
		const after = yield* getIssue(repo, issue);
		if (after._tag !== "Present") {
			return refuse(
				READBACK_MISMATCH,
				`triage kill: the writes on #${issue} landed but the read-back itself failed: ${
					after._tag === "Absent" ? "the issue is now absent" : after.reason
				} — the close is unverified.`,
				diagnostics,
			);
		}
		if (after.value.state !== "closed" || after.value.stateReason !== "not_planned") {
			return refuse(
				READBACK_MISMATCH,
				`triage kill: closed, but the read-back shows state=${after.value.state} state_reason=${
					after.value.stateReason ?? "none"
				}, not not_planned — #${issue} reads as done rather than killed.`,
				diagnostics,
			);
		}

		// The labels the step wrote are asserted too, or the strip is a fix nothing verifies: the
		// `closed-by-triage` add lands whether or not the removals did, so a read-back reading only
		// `state`/`state_reason` passes a killed issue still advertising `status:needs-triage` — the
		// defect itself. `home` is the read-back's own milestone, so this asserts the status facet and
		// makes no claim about a home the kill never touched.
		const observed = {labels: after.value.labels, milestone: after.value.milestone};
		if (shapeViolations(observed, facets, observed.milestone).length > 0) {
			return refuse(
				READBACK_MISMATCH,
				`triage kill: closed not-planned, but the read-back shows ${renderShape(observed, facets)} — expected every triage status label stripped from #${issue}.`,
				diagnostics,
			);
		}

		const foldedInto = duplicate === null ? null : duplicate.number;
		return json
			? answer(
					JSON.stringify({outcome: "killed", number: issue, foldedInto, redactions, provenance}),
					diagnostics,
				)
			: answer(`killed\t${issue}\t${foldedInto ?? "none"}`, diagnostics);
	});
