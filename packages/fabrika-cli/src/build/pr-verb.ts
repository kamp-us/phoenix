/**
 * The two guarded writes over a PR body: `build pr` opens one, `build pr-body` rewrites an open one.
 *
 * *Authoring* stays the skill's; the guards here are mechanical and run **in order, all before any
 * write**: stdin non-empty (`3`), no machine-local path (`5` / `6`), body shape (`4`), no
 * classification claim (`10`), then the claim and the target issue (`15` / `11` / `7`). The ordering
 * is the point — a body that would be refused should be refused before a PR exists to carry it.
 *
 * An already-open PR for this head branch is an **answer**, not an error: a create whose outcome could
 * not be proven (`8`) is re-run, and the re-run must not open a second PR (#4544's class).
 *
 * Both verbs live in one module because they must guard identically. `build pr-body` exists so a FAIL
 * whose whole fix is a body edit — the recurring one is a `## Deviations` section the review gate reads
 * as malformed — has a route that runs the guards, instead of a raw `gh` call that runs none (#5618).
 * It reorders one step and nothing else: it cannot name the served issue until it has read the PR, so
 * the two issue-dependent guards (`4`, and the closing-keyword half of it) sit after that read — still
 * before any write, which is the invariant the ordering is for.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getPullRequest} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {leakRefusal, readAuthored} from "./authored.ts";
import {requireSession} from "./claim.ts";
import {
	BAD_SECTIONS,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	WRONG_LANE,
	ZERO_SCOPE,
} from "./codes.ts";
import {createPull, defaultBranch, getPullHead, openPullForHead, updatePullBody} from "./github.ts";
import {parseLaneBranch} from "./lane.ts";
import {requireLane} from "./lane-guard.ts";
import {bodyDefect, classificationIn, proseOf} from "./pr-body.ts";
import {conventionalTitleOf} from "./pr-title.ts";
import {openIssue, resolveTargetRepo} from "./target.ts";

const VERB = "build pr";
const BODY_VERB = "build pr-body";

const surfaceFor = (verb: string) => ({
	verb,
	emptyMessage: `${verb}: stdin held nothing — the body is the input.`,
	bareAtMessage: `${verb}: the body is a bare @ path reference — write the body, not a pointer to it.`,
});

const SURFACE = surfaceFor(VERB);
const BODY_SURFACE = surfaceFor(BODY_VERB);

export interface PrOptions {
	readonly number: number;
	/** The acceptance criteria are not all met: the body must say `Part of #<n>`, not `Fixes #<n>`. */
	readonly partial: boolean;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

export interface PrBodyOptions {
	/** The open PR whose body is replaced. Nothing else about it moves. */
	readonly pr: number;
	readonly partial: boolean;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
}

/** The `4` refusal for each shape defect, in the contract's own words. */
const shapeRefusal = (
	verb: string,
	defect: NonNullable<ReturnType<typeof bodyDefect>>,
	issue: number,
	partial: boolean,
): VerbOutcome => {
	switch (defect._tag) {
		case "NoDeviations":
			return refuse(
				BAD_SECTIONS,
				`${verb}: the body's "## Deviations" section is not readable — ${defect.reason}. State each deviation as an entry, or state "None."`,
			);
		case "StrayClosing":
			return refuse(
				BAD_SECTIONS,
				`${verb}: the body carries a closing keyword aimed at #${defect.target} — this PR serves #${issue}.`,
			);
		case "ClosesWhilePartial":
			return refuse(
				BAD_SECTIONS,
				`${verb}: the body says "Fixes #${defect.target}" but --partial was given — a partial PR must say "Part of #${defect.target}".`,
			);
		case "DuplicateClosing":
			return refuse(
				BAD_SECTIONS,
				`${verb}: the body carries more than one closing keyword aimed at #${issue} — exactly one closes the issue.`,
			);
		case "NoLink":
			return refuse(
				BAD_SECTIONS,
				partial
					? `${verb}: the body names no "Part of #${issue}" line — a partial PR must say what it is part of.`
					: `${verb}: the body names no "Fixes #${issue}" line — a PR that closes its issue must say so.`,
			);
	}
};

/** The `10` refusal — the classification guard both write paths run over the body's prose. */
const classificationRefusal = (verb: string, body: string): VerbOutcome | null => {
	const classification = classificationIn(proseOf(body));
	if (classification === null) return null;
	return refuse(
		OFF_VOCABULARY,
		classification === "control-plane"
			? `${verb}: the body asserts a control-plane classification — that verdict is the merge gate's.`
			: `${verb}: the body asserts a ${classification} classification — that verdict is triage's.`,
	);
};

export const runPr = (
	options: PrOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {number, partial} = options;

		const authored = readAuthored(SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;
		const body = authored.text;

		const leaked = leakRefusal(VERB, body);
		if (leaked !== null) return leaked;

		const defect = bodyDefect(body, number, partial);
		if (defect !== null) return shapeRefusal(VERB, defect, number, partial);

		const classified = classificationRefusal(VERB, body);
		if (classified !== null) return classified;

		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openIssue(
			VERB,
			repo,
			number,
			(reason) => `${VERB}: cannot read #${number}: ${reason} — nothing was written.`,
		);
		if (target._tag === "Refused") return target.outcome;

		const lane = yield* requireLane(VERB, repo, session.id, number);
		if (lane._tag === "Refused") return lane.outcome;

		const existing = yield* openPullForHead(repo, lane.branch);
		if (existing._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the open pull requests for ${lane.branch}: ${existing.reason} — nothing was written.`,
				lane.notes,
			);
		}
		if (existing.value !== null) {
			return answer(
				JSON.stringify({
					answer: "existing",
					number: existing.value.number,
					url: existing.value.url,
				}),
				lane.notes,
			);
		}

		const base = yield* defaultBranch(repo);
		if (base._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${repo}'s default branch: ${base.reason} — nothing was written.`,
				lane.notes,
			);
		}

		const created = yield* createPull(
			repo,
			conventionalTitleOf(target.issue.title, target.issue.labels),
			lane.branch,
			base.value,
			body,
		);
		if (created._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the create failed: ${created.reason} — it may or may not have landed; re-run, the verb re-checks for an existing PR first.`,
				lane.notes,
			);
		}

		const back = yield* getPullRequest(repo, created.value.number);
		const matches =
			back._tag === "Present" &&
			normalizeForReadback(back.value.body) === normalizeForReadback(body);
		return matches
			? answer(
					JSON.stringify({answer: "opened", number: created.value.number, url: created.value.url}),
					lane.notes,
				)
			: refuse(
					READBACK_MISMATCH,
					`${VERB}: the PR landed (#${created.value.number}) but its body does not read back as sent — it needs a human eye.`,
					lane.notes,
				);
	});

/**
 * The issue an open PR serves, read off its head ref rather than off its body.
 *
 * The head ref is a create-mode lane branch — `build/<issue>-<slug>-<nonce>` — even for a PR the
 * repairer resumed, because resume mode checks out `build/pr-<pr>-<nonce>` locally and tracks the
 * original ref (`build branch --resume`). The body is deliberately not a source: the closing keyword
 * is exactly what this verb checks, so trusting it would let a mistargeted body validate itself.
 */
const servedIssueOf = (headRef: string): number | null => {
	const lane = parseLaneBranch(headRef);
	return lane === null || lane._tag !== "Create" ? null : lane.number;
};

export const runPrBody = (
	options: PrBodyOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {pr, partial} = options;

		const authored = readAuthored(BODY_SURFACE, yield* options.stdin);
		if (authored._tag === "Refused") return authored.outcome;
		const body = authored.text;

		const leaked = leakRefusal(BODY_VERB, body);
		if (leaked !== null) return leaked;

		const classified = classificationRefusal(BODY_VERB, body);
		if (classified !== null) return classified;

		const session = requireSession(BODY_VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(BODY_VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const head = yield* getPullHead(repo, pr);
		if (head._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${BODY_VERB}: cannot read PR #${pr}: ${head.reason} — nothing was written.`,
			);
		}
		if (head._tag === "Absent" || head.value.state !== "open") {
			return refuse(
				ZERO_SCOPE,
				`${BODY_VERB}: PR #${pr} is proven absent, closed or merged — there is no body to rewrite.`,
			);
		}

		const issue = servedIssueOf(head.value.ref);
		if (issue === null) {
			return refuse(
				WRONG_LANE,
				`${BODY_VERB}: PR #${pr}'s head branch "${head.value.ref}" is not a lane branch — this verb rewrites a lane's own PR.`,
			);
		}

		const defect = bodyDefect(body, issue, partial);
		if (defect !== null) return shapeRefusal(BODY_VERB, defect, issue, partial);

		const lane = yield* requireLane(BODY_VERB, repo, session.id, null);
		if (lane._tag === "Refused") return lane.outcome;
		const addressed =
			lane.lane._tag === "Resume" ? lane.lane.pr === pr : lane.branch === head.value.ref;
		if (!addressed) {
			return refuse(
				WRONG_LANE,
				`${BODY_VERB}: the checked-out branch "${lane.branch}" does not serve PR #${pr} — wrong lane.`,
				lane.notes,
			);
		}

		const updated = yield* updatePullBody(repo, pr, body);
		if (updated._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${BODY_VERB}: the update failed: ${updated.reason} — it may or may not have landed; re-read PR #${pr} before retrying.`,
				lane.notes,
			);
		}

		const back = yield* getPullRequest(repo, pr);
		const matches =
			back._tag === "Present" &&
			normalizeForReadback(back.value.body) === normalizeForReadback(body);
		return matches
			? answer(
					JSON.stringify({
						answer: "updated",
						number: updated.value.number,
						url: updated.value.url,
					}),
					lane.notes,
				)
			: refuse(
					READBACK_MISMATCH,
					`${BODY_VERB}: PR #${pr}'s body was replaced but does not read back as sent — it needs a human eye.`,
					lane.notes,
				);
	});
