/**
 * `lane prove` — read the artifact a lane event claims, before the event is recorded.
 *
 * "Artifacts over self-reports" was the retired epic conductor's standing rule, enforced by reading
 * the git graph. This is the lane machine's counterpart, and which artifact it reads is the task's
 * own shape: a single-issue lane and an epic run's tail are contradicted by an open PR tracing to
 * the task's issue and the verdicts on it (ADR 0283 — that ordering is GitHub's, never the local
 * ledger's); an epic run's child opens no PR at all (ADR 0285), so its `DONE` is contradicted by the
 * commits its branch adds over the epic branch, read off this tree, and its `PASS` by a range-bound
 * verdict on the child issue that still binds the content it judged (ADR 0276).
 *
 * **It writes nothing.** The proof sits beside `lane transition` rather than inside it so the
 * append path stays pure, offline and byte-identical on refusal; what makes it non-optional is its
 * two callers, which each run it first and record only on its exit 0 — `operate` step 3 for the
 * operator's own append, and `lane report` for a shell recording its own terminal token.
 *
 * Every refusal names what it looked for, and the failing readings stay on their own codes because
 * their remedies are opposite: nothing there, not finished yet, says the other thing, several
 * candidates. The four are the artifact-independent vocabulary, so the range arms allocate no new
 * seat — what a caller must do about "the artifact is not there" does not change with its kind.
 */
import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveTargetRepo} from "../build/target.ts";
import {governedRootsOr} from "../config/paths.ts";
import {getIssue, listComments} from "../io/issues.ts";
import {getPullRequest, listPullFiles, openPullsClosing, searchOpenPulls} from "../io/pulls.ts";
import {readAdvisory} from "../review/advisory.ts";
import {
	issueRefOf,
	partitionWithUi,
	ROUTED_NAMESPACES,
	shipNamespacesOf,
} from "../review/classes.ts";
import {bindRange, contentDigestAt, rangeContentAt} from "../review/content-binding.ts";
import {bindHead} from "../review/head.ts";
import {CODEOWNERS_PATH, readBoundary} from "../ship/boundary.ts";
import {classify} from "../ship/codeowners.ts";
import {ROUTABLE} from "../ship/gate-verb.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readRangeMarker} from "../wire/range-verdict-marker.ts";
import {readNamespaced as readRoute} from "../wire/routed-elsewhere.ts";
import {bindToContent, read as readMarker} from "../wire/verdict-marker.ts";
import {
	LANE_UNREADABLE,
	PROOF_ABSENT,
	PROOF_AMBIGUOUS,
	PROOF_CONTRADICTED,
	PROOF_IN_FLIGHT,
	TASK_UNKNOWN,
} from "./codes.ts";
import {foldLog, nextLeaf, resolveTask} from "./fold.ts";
import {
	claimOf,
	epicOf,
	foldNamespaces,
	INVESTIGATION_LABEL,
	issueOf,
	judgeVerdicts,
	type NamespaceRow,
	type Proof,
	type PullFact,
	roleOf,
	traceDiagnosis,
	tracePulls,
	type VerdictFact,
} from "./prove.ts";
import {type ChildRange, locateRange} from "./range.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LaneRef, loadLane} from "./store.ts";

const VERB = "fabrika lane prove";

/** One namespace's newest claim, before the binding question is asked of it. */
interface Claim {
	readonly namespace: string;
	readonly polarity: "PASS" | "FAIL" | "ROUTED";
	readonly commentId: number;
	readonly sha: string;
	readonly content: string | null;
}

export interface ProveOptions extends LaneRef {
	/** The operator event the caller is about to record; folded to upper case like `transition`. */
	readonly event: string;
	/** The task the event addresses; `null` resolves only on a single-task lane. */
	readonly task: string | null;
	/**
	 * The lane classes the caller is about to record, exactly as `lane report` validated them —
	 * `null` leaves the classes already standing alone, the fold's own rule (ADR 0317). They are an
	 * input here because they pick the arm the event takes, and the arm picks which cell owes the
	 * routed namespace (#6664).
	 */
	readonly classes: ReadonlyArray<string> | null;
	readonly repo: string | null;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in, not the ledger root. */
	readonly cwd: string;
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
		const role = roleOf(taskId, epicOf(Object.keys(loaded.lane.tasks)));
		const routing = nextLeaf(loaded.lane, fold.states, taskId, event, options.classes);
		const claim = claimOf(event, leaf, role, routing);
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
				`${VERB}: neither task "${taskId}" nor lane "${options.lane}" names an issue number, so there is no target to prove ${event} against.`,
			);
		}

		// A child's range lives in this tree, not on the board, so the repo is not resolved for it —
		// a `gh`-shaped read that failed would report a range this verb never needed as UNKNOWN.
		if (claim._tag === "RangeCommits") {
			const read = yield* located(claim.epic, issue);
			if (read._tag === "Refused") return read.outcome;
			return answer(
				JSON.stringify(
					{
						proof: "proven",
						event,
						task: taskId,
						issue,
						evidence: {
							kind: "range-commits",
							epic: claim.epic,
							branch: read.range.branch,
							range: {base: read.range.base, tip: read.range.tip},
							commits: read.range.commits,
							naming: read.range.naming,
						},
					},
					null,
					2,
				),
				read.notes,
			);
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		// Only the verdict arms need it: the two arms above prove commits and states, and neither asks
		// what namespace a diff derives.
		const governed = yield* governedRootsOr(
			VERB,
			options.cwd,
			"the required namespace set is UNKNOWN, and a set short one namespace would prove an event nobody gated.",
		);
		if (governed._tag === "Refused") return refuse(LANE_UNREADABLE, governed.message);

		if (claim._tag === "RangeVerdict") {
			return yield* proveRangeVerdicts(repo, claim.epic, issue, taskId, event, governed.roots);
		}

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
		return yield* proveVerdicts(
			repo,
			traced.trace.pr,
			issue,
			taskId,
			event,
			diagnostics,
			governed.roots,
			claim.defers,
		);
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
 * Every namespace this PR's diff derives that the state being left owes, judged at its live head.
 *
 * The derivation is `ship scope`'s own pair — the `ui`-bearing partition and the namespace map that
 * appends the `governance` floor — so the bar this proves against is the same object the merge gate
 * enforces rather than a second reading of it.
 *
 * `defers` is the one subtraction, and it is a routing fact rather than a relaxation: it is non-empty
 * only where this lane's own machine takes the deferred namespace's event into the cell that owes it,
 * so a subtraction can never outlive the round it hands the work to (ADR 0320). Demanding `review-ui`
 * of the very `PASS` that enters `review:ui` demanded a verdict from a cell the lane had not reached
 * (#6664/#6793); demanding it of a `PASS` that walks to `ship` is the floor, and it still stands.
 * `ship gate` re-derives the full set at the merge either way.
 *
 * On a control-plane PR the reviewer's PASS arrives through the §CP advisory carrier by design —
 * no first-line marker, the head in the body (ADR 0111/0226) — so a marker-only read would row it
 * `absent` and hold the lane at `PROOF_IN_FLIGHT` forever. The advisory is read exactly as
 * `ship gate`'s `candidateOf` reads it: head-bound with no content binding (ADR 0276), a `[FAIL]`
 * row treated as fail (an invalid emission, reported) — and admitted only after the diff itself
 * classifies control-plane through the shipped `classify` over CODEOWNERS at the PR's base ref,
 * never a caller assertion. On any other PR a marker-less comment stays no verdict.
 *
 * The third carrier is the `routed-elsewhere` record, read for `ROUTABLE` alone and admitted for
 * the reason `ship gate` admits it: `review-ui`'s emit path cannot answer a diff that renders
 * nothing, so requiring the namespace without reading the route would hold such a lane at `review`
 * with no work left that could free it (ADR 0316). It is read exactly as `candidateOf` reads it —
 * head-bound, no content binding, one namespace.
 */
const proveVerdicts = (
	repo: string,
	pr: number,
	issue: number,
	taskId: string,
	event: string,
	diagnostics: ReadonlyArray<string>,
	roots: ReadonlyArray<string>,
	defers: ReadonlyArray<string>,
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
		const derived = shipNamespacesOf(partitionWithUi(files.value, roots));
		const deferred = derived.filter((namespace) => defers.includes(namespace));
		const required = derived.filter((namespace) => !defers.includes(namespace));

		const commented = yield* listComments(repo, pr);
		if (commented._tag === "Failure") {
			return unreadable(`the comments on #${pr}`, commented.reason);
		}

		// Newest write stamp wins per namespace — the same ordering key `ship gate` folds on, because
		// a FAIL upserted after a PASS must win (#4200).
		const latest = new Map<string, Claim>();
		const stamps = new Map<string, string>();
		const advisories: {readonly claim: Claim; readonly stamp: string}[] = [];
		const standing = (claim: Claim, stamp: string): void => {
			const seen = stamps.get(claim.namespace);
			if (seen !== undefined && seen > stamp) return;
			stamps.set(claim.namespace, stamp);
			latest.set(claim.namespace, claim);
		};
		for (const comment of commented.value) {
			const parsed = readMarker(comment.body);
			if (parsed._tag === "Found") {
				const marker = parsed.value;
				if (!required.includes(marker.namespace)) continue;
				standing(
					{
						namespace: marker.namespace,
						polarity: marker.polarity,
						commentId: comment.id,
						sha: marker.sha,
						content: marker.content,
					},
					comment.updatedAt,
				);
				continue;
			}
			const route = readRoute(comment.body, ROUTABLE);
			if (route !== null) {
				if (!required.includes(route.namespace)) continue;
				standing(
					{
						namespace: route.namespace,
						polarity: "ROUTED",
						commentId: comment.id,
						sha: route.sha,
						// Head-bound, never content-bound (ADR 0316) — a push re-opens the question, so the
						// route takes the pre-0276 binding and can never gain survival it did not earn.
						content: null,
					},
					comment.updatedAt,
				);
				continue;
			}
			const advisory = readAdvisory(comment.body);
			if (advisory !== null && required.includes(advisory.namespace)) {
				advisories.push({
					claim: {
						namespace: advisory.namespace,
						// ADR 0226 makes the advisory carrier PASS-only; a [FAIL] row inside one is an
						// invalid emission — treated as fail below, never read as a pass.
						polarity: /\[FAIL\]/.test(comment.body) ? "FAIL" : "PASS",
						commentId: comment.id,
						sha: advisory.sha,
						// The advisory withholds a content binding by design (ADR 0276) — head-bound only.
						content: null,
					},
					stamp: comment.updatedAt,
				});
			}
		}

		const unrouted = derived.filter(
			(namespace) => ROUTED_NAMESPACES.includes(namespace) && !defers.includes(namespace),
		);
		const notes = [
			...diagnostics,
			...deferred.map(
				(namespace) =>
					`${VERB}: ${namespace} on #${pr} is owed by the cell this event routes into, not by this one — the event being proven is that arm, so requiring it here is the deadlock #6664 closed.`,
			),
			...unrouted.map(
				(namespace) =>
					`${VERB}: #${pr} derives ${namespace} and this event routes into no cell that could fill it, so it is required here — relay the class \`review scope\` printed (\`lane report … --class ui\`) if this lane's machine carries the rendered round (ADR 0320).`,
			),
		];
		if (advisories.length > 0) {
			const boundary = yield* readBoundary(repo, pull.value.baseRef);
			if (boundary._tag === "Unreadable") {
				return unreadable(`${CODEOWNERS_PATH} at ${pull.value.baseRef}`, boundary.reason);
			}
			const cp = classify(boundary.rows, files.value);
			if (cp === "control-plane") {
				for (const {claim, stamp} of advisories) {
					if (claim.polarity === "FAIL") {
						notes.push(
							`${VERB}: #${pr} carries a §CP advisory with a [FAIL] row — an invalid emission (ADR 0226); treated as fail, report it.`,
						);
					}
					const seen = stamps.get(claim.namespace);
					if (seen !== undefined && seen > stamp) continue;
					stamps.set(claim.namespace, stamp);
					latest.set(claim.namespace, claim);
					notes.push(
						`${VERB}: ${claim.namespace} on #${pr} is advisory-carried (§CP, ADR 0111) — head-bound at ${claim.sha}, no content binding (ADR 0276).`,
					);
				}
			} else {
				notes.push(
					`${VERB}: #${pr} classifies ${cp} against ${CODEOWNERS_PATH} at ${pull.value.baseRef}, so a marker-less advisory-shaped comment reads as no verdict.`,
				);
			}
		}
		const claims = [...latest.values()];
		for (const claim of claims) {
			if (claim.polarity !== "ROUTED") continue;
			notes.push(
				`${VERB}: ${claim.namespace} on #${pr} is routed rather than judged — a routed-elsewhere record at ${claim.sha} states this PR owes no verdict (ADR 0316).`,
			);
		}
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
				bound._tag === "Bound"
					? yield* contentDigestAt(bound.head.mergeBase, bound.head.sha)
					: null;
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

		const proof = foldNamespaces(rows, `#${pr}`);
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

interface Located {
	readonly _tag: "Located";
	readonly range: ChildRange;
	readonly notes: ReadonlyArray<string>;
}

type Refused = {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/** The shared range read (`./range.ts`), seated into this verb's proof codes. */
const located = (
	epic: number,
	issue: number,
): Effect.Effect<Located | Refused, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.map(locateRange(VERB, epic, issue), (location) => {
		if (location._tag === "Located") {
			return {_tag: "Located" as const, range: location.range, notes: location.notes};
		}
		if (location._tag === "Unreadable") {
			return {_tag: "Refused" as const, outcome: unreadable(location.what, location.reason)};
		}
		return {
			_tag: "Refused" as const,
			outcome: seat({_tag: location._tag, what: location.why}, location.notes),
		};
	});

/**
 * One namespace's newest range-scoped claim, before the binding question is asked of it.
 *
 * Two carriers, two bindings, so the union rather than a nullable `content`: a range verdict binds
 * the digest its reviewer judged (ADR 0276), a `routed-elsewhere` record binds the tip it was
 * attested at and nothing else (ADR 0316). A field that could hold either would let the wrong
 * binding be asked of a claim silently.
 */
type RangeClaim =
	| {
			readonly _tag: "Verdict";
			readonly namespace: string;
			readonly polarity: "PASS" | "FAIL";
			readonly commentId: number;
			readonly content: string;
			readonly range: string;
	  }
	| {
			readonly _tag: "Route";
			readonly namespace: string;
			readonly commentId: number;
			readonly sha: string;
	  };

/**
 * The child arm of the `PASS` claim: a range-bound verdict on the child issue that still binds.
 *
 * The required namespaces are derived from the range's own changed paths through the same
 * `ship scope` pair the PR arm uses, so a child's bar is the tail's bar asked of a different scope.
 * What binds is content and only content (ADR 0276): the two
 * SHAs a range marker names stop being history the moment the range merges into the epic branch, so
 * `bindRange` compares the digest the reviewer recorded against the digest this range carries now —
 * a verdict written over a sibling's range, or over a tip the builder has since moved past, reads
 * `Stale` and refuses.
 *
 * A comment carrying a PR-scoped marker is `Malformed` to this reader rather than absent, and is
 * counted into the diagnostics instead of dropped: a verdict posted in the wrong format is the one
 * failure that would otherwise present as "the reviewer never ran".
 *
 * A `routed-elsewhere` record resolves `ROUTABLE` here too — a child's `apps/web/src` diff can
 * render nothing exactly as a PR's can — and it binds the range's **tip**, not the range digest.
 * The record's format is head-bound by construction (ADR 0316) and carries no digest to compare, so
 * the tip is the one object name the tree it attested has; every push moves it and voids the route.
 */
const proveRangeVerdicts = (
	repo: string,
	epic: number,
	issue: number,
	taskId: string,
	event: string,
	roots: ReadonlyArray<string>,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const read = yield* located(epic, issue);
		if (read._tag === "Refused") return read.outcome;
		const range = `${read.range.base}..${read.range.tip}`;

		const content = yield* rangeContentAt({base: read.range.base, tip: read.range.tip});
		if (content._tag === "Failure") {
			return unreadable(`the content ${range} changes`, content.reason);
		}
		const required = shipNamespacesOf(partitionWithUi(content.value.paths, roots));

		const commented = yield* listComments(repo, issue);
		if (commented._tag === "Failure") {
			return unreadable(`the comments on #${issue}`, commented.reason);
		}

		// Newest write stamp wins per namespace — the ordering the PR arm folds on, for the reason it
		// folds on it: a FAIL upserted after a PASS must win (#4200).
		const latest = new Map<string, RangeClaim>();
		const stamps = new Map<string, string>();
		const malformed: string[] = [];
		const standing = (claim: RangeClaim, stamp: string): void => {
			const seen = stamps.get(claim.namespace);
			if (seen !== undefined && seen > stamp) return;
			stamps.set(claim.namespace, stamp);
			latest.set(claim.namespace, claim);
		};
		for (const comment of commented.value) {
			const parsed = readRangeMarker(comment.body);
			if (parsed._tag === "Malformed") {
				malformed.push(`#${comment.id}: ${parsed.reason}`);
				continue;
			}
			if (parsed._tag === "Found") {
				const marker = parsed.value;
				if (!required.includes(marker.namespace)) continue;
				standing(
					{
						_tag: "Verdict",
						namespace: marker.namespace,
						polarity: marker.polarity,
						commentId: comment.id,
						content: marker.content,
						range: `${marker.range.base}..${marker.range.tip}`,
					},
					comment.updatedAt,
				);
				continue;
			}
			const route = readRoute(comment.body, ROUTABLE);
			if (route === null || !required.includes(route.namespace)) continue;
			standing(
				{_tag: "Route", namespace: route.namespace, commentId: comment.id, sha: route.sha},
				comment.updatedAt,
			);
		}

		const claims = [...latest.values()];
		const inForce: VerdictFact[] = claims.map((claim) => {
			if (claim._tag === "Route") {
				// A route binds the tip it was attested at, never the range digest: the record is a claim
				// about pixels at one tree, and the child's tip is the only object name that tree has.
				const binding = bindToContent({sha: claim.sha, content: null}, read.range.tip, null);
				return {
					namespace: claim.namespace,
					polarity: "ROUTED" as const,
					binding:
						binding._tag === "Current" ? "current" : binding._tag === "Stale" ? "stale" : "unknown",
					commentId: claim.commentId,
				};
			}
			const binding = bindRange(claim, {_tag: "Digest", digest: content.value.digest});
			return {
				namespace: claim.namespace,
				polarity: claim.polarity,
				binding:
					binding._tag === "Current" ? "current" : binding._tag === "Stale" ? "stale" : "unknown",
				commentId: claim.commentId,
			};
		});
		const rows: ReadonlyArray<NamespaceRow> = judgeVerdicts(required, inForce);
		const notes = [
			...read.notes,
			`${VERB}: ${range} changes ${content.value.paths.length} path(s) at content ${content.value.digest} and derives ${required.join(", ")}; read ${commented.value.length} comment(s) on #${issue}.`,
			...claims.map((claim) =>
				claim._tag === "Verdict"
					? `${VERB}: ${claim.namespace} claims ${claim.polarity} over range ${claim.range} bound to content ${claim.content}.`
					: `${VERB}: ${claim.namespace} is routed rather than judged — a routed-elsewhere record at ${claim.sha} states this range owes no verdict (ADR 0316).`,
			),
			...malformed.map(
				(reason) =>
					`${VERB}: a comment on #${issue} reaches for a verdict marker and is not a range one — ${reason}`,
			),
		];

		const proof = foldNamespaces(rows, `${range} (content ${content.value.digest})`);
		if (proof._tag !== "Proven") return seat(proof, notes);
		return answer(
			JSON.stringify(
				{
					proof: "proven",
					event,
					task: taskId,
					issue,
					evidence: {
						kind: "range-verdicts",
						epic,
						branch: read.range.branch,
						range: {base: read.range.base, tip: read.range.tip},
						content: content.value.digest,
						namespaces: rows,
					},
				},
				null,
				2,
			),
			notes,
		);
	});
