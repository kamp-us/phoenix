/**
 * `lane prove` — read the artifact a lane event claims, before the event is recorded.
 *
 * `build-epic`'s standing rule is "artifacts over self-reports", enforced by `epic landed` reading
 * the git graph. This is the lane machine's counterpart, and it reads the board instead: a lane
 * operator owns no branch, so the only thing that can contradict a spawn's report is an open PR
 * tracing to the task's issue and the verdicts on it (ADR 0283 — that ordering is GitHub's, never
 * the local ledger's).
 *
 * **It writes nothing.** The proof sits beside `lane transition` rather than inside it so the
 * append path stays pure, offline and byte-identical on refusal; what makes it non-optional is
 * `operate` step 3, which runs it first and records only on its exit 0.
 *
 * Every refusal names what it looked for, and the three failing readings stay on three codes
 * because their remedies are opposite: nothing there, not finished yet, says the other thing.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveTargetRepo} from "../build/target.ts";
import {getIssue, listComments} from "../io/issues.ts";
import {getPullRequest, listPullFiles, openPullsClosing, searchOpenPulls} from "../io/pulls.ts";
import {issueRefOf, namespacesOf, partition, touchesGovernanceRoot} from "../review/classes.ts";
import {contentDigestAt} from "../review/content-binding.ts";
import {bindHead} from "../review/head.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {bindToContent, read as readMarker} from "../wire/verdict-marker.ts";
import {
	LANE_UNREADABLE,
	PROOF_ABSENT,
	PROOF_AMBIGUOUS,
	PROOF_CONTRADICTED,
	PROOF_IN_FLIGHT,
	TASK_UNKNOWN,
} from "./codes.ts";
import {foldLog, resolveTask} from "./fold.ts";
import {
	claimOf,
	foldNamespaces,
	INVESTIGATION_LABEL,
	issueOf,
	judgeVerdicts,
	type NamespaceRow,
	type Proof,
	type PullFact,
	traceDiagnosis,
	tracePulls,
	type VerdictFact,
} from "./prove.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane prove";

/** One namespace's newest verdict claim, before the binding question is asked of it. */
interface Claim {
	readonly namespace: string;
	readonly polarity: "PASS" | "FAIL";
	readonly commentId: number;
	readonly sha: string;
	readonly content: string | null;
}

export interface ProveOptions extends LaneRef {
	/** The operator event the caller is about to record; folded to upper case like `transition`. */
	readonly event: string;
	/** The task the event addresses; `null` resolves only on a single-task lane. */
	readonly task: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** A board read that failed leaves the proof UNKNOWN — never "the artifact is not there". */
const unreadable = (what: string, reason: string): VerbOutcome =>
	refuse(
		LANE_UNREADABLE,
		`${VERB}: cannot read ${what}: ${reason} — whether the event is proven is UNKNOWN, never proven and never refused.`,
	);

const seat = (proof: Exclude<Proof, {_tag: "Proven"}>, diagnostics: ReadonlyArray<string>) => {
	const code = {
		Absent: PROOF_ABSENT,
		InFlight: PROOF_IN_FLIGHT,
		Contradicted: PROOF_CONTRADICTED,
		Ambiguous: PROOF_AMBIGUOUS,
	}[proof._tag];
	return refuse(code, `${VERB}: unproven — ${proof.what}`, diagnostics);
};

export const runProve = (
	options: ProveOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const loaded = yield* loadLane(options);
		if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
		const task = resolveTask(loaded.lane, options.task);
		if (task._tag === "Unresolved") return refuse(TASK_UNKNOWN, `${VERB}: ${task.reason}`);
		const fold = foldLog(loaded.lane, loaded.entries);
		if (fold._tag !== "Folded") return replayRefusal(VERB, loaded.logPath, fold);

		const taskId = task.taskId;
		const leaf = fold.states[taskId]?.type ?? "";
		const event = options.event.toUpperCase();
		const claim = claimOf(event, leaf);
		if (claim._tag === "None") {
			return answer(
				JSON.stringify({proof: "not-required", event, task: taskId, state: leaf}, null, 2),
				[`${VERB}: ${claim.why} — nothing to prove, record it.`],
			);
		}

		const issue = issueOf(taskId, options.lane);
		if (issue === null) {
			return refuse(
				TASK_UNKNOWN,
				`${VERB}: neither task "${taskId}" nor lane "${options.lane}" names an issue number, so there is no board target to prove ${event} against.`,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const traced = yield* traceOpenPull(repo, issue);
		if (traced._tag === "Refused") return traced.outcome;
		const diagnostics = [
			`${VERB}: looked for an open PR in ${repo} whose body links #${issue} (Fixes/Part of); ${traced.scanned} candidate(s) read.`,
		];

		if (claim._tag === "OpenPull") {
			if (traced.trace._tag === "Many") {
				return seat(
					{
						_tag: "Ambiguous",
						what: `#${issue} is linked by ${traced.trace.prs.map((pr) => `#${pr}`).join(", ")} — which one this lane owns is not derivable here`,
					},
					diagnostics,
				);
			}
			if (traced.trace._tag === "One") {
				return answer(
					JSON.stringify(
						{
							proof: "proven",
							event,
							task: taskId,
							issue,
							evidence: {kind: "open-pull", pr: traced.trace.pr},
						},
						null,
						2,
					),
					diagnostics,
				);
			}
			return yield* proveNoPull(repo, issue, taskId, event, loaded.entries, diagnostics);
		}

		if (traced.trace._tag !== "One") {
			return seat(
				traced.trace._tag === "Many"
					? {
							_tag: "Ambiguous",
							what: `#${issue} is linked by ${traced.trace.prs.map((pr) => `#${pr}`).join(", ")} — which one carries the verdicts is not derivable here`,
						}
					: {
							_tag: "Absent",
							what: `no open PR links #${issue}, so there is nothing a verdict could have been written on`,
						},
				diagnostics,
			);
		}
		return yield* proveVerdicts(repo, traced.trace.pr, issue, taskId, event, diagnostics);
	});

interface Traced {
	readonly _tag: "Traced";
	readonly trace: ReturnType<typeof tracePulls>;
	readonly scanned: number;
}

/**
 * The open PRs linking this issue, each read as its own record.
 *
 * Two nomination reads, unioned, because neither alone answers the question. The closing-issue edge
 * (`openPullsClosing`) is authoritative and lag-free but blind to `Part of #N`, the shape
 * `build --partial` emits; the search index sees any body but lags a fresh PR — and this verb runs
 * at the worst moment for that lag, right after a builder reports `SHIPPED-PR`. Reading the edge
 * first means a lagging index can only fail to add a candidate, never hide the closing one, so a
 * lane that shipped is not recorded `BLOCKED` on exit `22`. `lane brief` asks the same question
 * through the same edge, so the two lane verbs agree on the closing-link half.
 *
 * Both reads only nominate; the body's link decides. A candidate that has closed since it was
 * nominated, or that only mentions the number in prose, drops out here rather than counting as
 * proof — so unioning in the looser read widens candidates without widening what counts.
 */
const traceOpenPull = (
	repo: string,
	issue: number,
): Effect.Effect<
	Traced | {readonly _tag: "Refused"; readonly outcome: VerbOutcome},
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const closing = yield* openPullsClosing(repo, issue);
		if (closing._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: unreadable(`the open pull requests closing #${issue}`, closing.reason),
			};
		}
		const found = yield* searchOpenPulls(repo, [`${issue}`, "in:body"]);
		if (found._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: unreadable(`the open pull requests mentioning #${issue}`, found.reason),
			};
		}
		const candidates = new Set([...closing.value.map((pull) => pull.number), ...found.value]);
		const facts: PullFact[] = [];
		for (const candidate of candidates) {
			const pull = yield* getPullRequest(repo, candidate);
			if (pull._tag === "Unknown") {
				return {
					_tag: "Refused" as const,
					outcome: unreadable(`PR #${candidate}`, pull.reason),
				};
			}
			if (pull._tag === "Absent") continue;
			facts.push({
				number: pull.value.number,
				open: pull.value.state === "open",
				linkedIssue: issueRefOf(pull.value.body).number,
			});
		}
		return {_tag: "Traced" as const, trace: tracePulls(issue, facts), scanned: facts.length};
	});

/**
 * The no-PR arm: `build`'s `SUCCESS-NO-PR`, which is a legal `DONE` and must not read as an unproven
 * one. It is not taken on the spawn's word either — the two artifacts are the `type:investigation`
 * label and a diagnosis comment written after the task entered build.
 */
const proveNoPull = (
	repo: string,
	issue: number,
	taskId: string,
	event: string,
	entries: ReadonlyArray<{readonly task: string; readonly at: string}>,
	diagnostics: ReadonlyArray<string>,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getIssue(repo, issue);
		if (found._tag === "Unknown") return unreadable(`issue #${issue}`, found.reason);
		if (found._tag === "Absent") {
			return seat(
				{_tag: "Absent", what: `no open PR links #${issue}, and #${issue} itself is not there`},
				diagnostics,
			);
		}
		const commented = yield* listComments(repo, issue);
		if (commented._tag === "Failure") {
			return unreadable(`the comments on #${issue}`, commented.reason);
		}
		const since = entries.filter((entry) => entry.task === taskId).at(-1)?.at ?? null;
		const diagnosis = traceDiagnosis(issue, found.value.labels, commented.value, since);
		const looked = [
			...diagnostics,
			`${VERB}: no PR traced, so looked for the no-PR outcome instead — ${INVESTIGATION_LABEL} on #${issue} and a comment written since ${since ?? "the lane opened"}.`,
		];
		if (diagnosis._tag === "Absent") {
			return seat(
				{
					_tag: "Absent",
					what: `no open PR links #${issue}, and ${diagnosis.why} — the ${event} rests on the spawn's word alone`,
				},
				looked,
			);
		}
		return answer(
			JSON.stringify(
				{
					proof: "proven",
					event,
					task: taskId,
					issue,
					evidence: {kind: "diagnosis", commentId: diagnosis.commentId},
				},
				null,
				2,
			),
			looked,
		);
	});

/**
 * Every namespace this PR's diff derives, judged at its live head.
 *
 * The derivation is `review scope`'s partition plus the `governance` floor `ship gate` applies —
 * the same two shipped functions, so the bar this proves against cannot drift from the bar the
 * gates enforce. `review-ui` is deliberately not derived here: the rendered-visual verdict is
 * `review-ui`'s own lane and the lane machine spawns no shell that emits it, so requiring it would
 * stall every UI lane on a verdict nothing in this loop writes.
 */
const proveVerdicts = (
	repo: string,
	pr: number,
	issue: number,
	taskId: string,
	event: string,
	diagnostics: ReadonlyArray<string>,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const pull = yield* getPullRequest(repo, pr);
		if (pull._tag === "Unknown") return unreadable(`PR #${pr}`, pull.reason);
		if (pull._tag === "Absent") {
			return seat({_tag: "Absent", what: `PR #${pr} is not there`}, diagnostics);
		}
		const head = pull.value.headSha;

		const files = yield* listPullFiles(repo, pr);
		if (files._tag === "Failure") {
			return unreadable(`the changed files of #${pr}`, files.reason);
		}
		const required = [
			...namespacesOf(partition(files.value)),
			...(touchesGovernanceRoot(files.value) ? ["governance"] : []),
		];

		const commented = yield* listComments(repo, pr);
		if (commented._tag === "Failure") {
			return unreadable(`the comments on #${pr}`, commented.reason);
		}

		// Newest write stamp wins per namespace — the same ordering key `ship gate` folds on, because
		// a FAIL upserted after a PASS must win (#4200).
		const latest = new Map<string, Claim>();
		const stamps = new Map<string, string>();
		for (const comment of commented.value) {
			const parsed = readMarker(comment.body);
			if (parsed._tag !== "Found") continue;
			const marker = parsed.value;
			if (!required.includes(marker.namespace)) continue;
			const seen = stamps.get(marker.namespace);
			if (seen !== undefined && seen > comment.updatedAt) continue;
			stamps.set(marker.namespace, comment.updatedAt);
			latest.set(marker.namespace, {
				namespace: marker.namespace,
				polarity: marker.polarity,
				commentId: comment.id,
				sha: marker.sha,
				content: marker.content,
			});
		}

		const notes = [...diagnostics];
		const claims = [...latest.values()];
		// A verdict survives a head move only through the content it bound (ADR 0276), so the digest
		// is computed exactly when a head-only read would call a content-bearing verdict stale.
		let digest: string | null = null;
		if (
			claims.some(
				(claim) => claim.content !== null && bindToContent(claim, head, null)._tag !== "Current",
			)
		) {
			const bound = yield* bindHead(VERB, repo, pr, pull.value, null);
			const computed =
				bound._tag === "Bound" ? yield* contentDigestAt(bound.head.base, bound.head.sha) : null;
			if (computed !== null && computed._tag === "Ok") digest = computed.value;
			if (digest === null) {
				notes.push(
					`${VERB}: this head's content digest could not be computed, so a content-bound verdict at a moved head stays UNKNOWN rather than current.`,
				);
			}
		}

		const inForce: VerdictFact[] = claims.map((claim) => {
			const binding = bindToContent(claim, head, digest);
			return {
				namespace: claim.namespace,
				polarity: claim.polarity,
				binding:
					binding._tag === "Current" ? "current" : binding._tag === "Stale" ? "stale" : "unknown",
				commentId: claim.commentId,
			};
		});
		const rows: ReadonlyArray<NamespaceRow> = judgeVerdicts(required, inForce);
		notes.push(
			`${VERB}: #${pr} at ${head} derives ${required.join(", ")}; read ${commented.value.length} comment(s).`,
		);

		const proof = foldNamespaces(rows, pr);
		if (proof._tag !== "Proven") return seat(proof, notes);
		return answer(
			JSON.stringify(
				{
					proof: "proven",
					event,
					task: taskId,
					issue,
					evidence: {kind: "head-verdicts", pr, head, namespaces: rows},
				},
				null,
				2,
			),
			notes,
		);
	});
