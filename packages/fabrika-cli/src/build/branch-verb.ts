/**
 * `build branch` — cut, or resume, the lane's nonce branch off a **freshly fetched** base.
 *
 * The lane-identity rule lives in `lane.ts`; this verb is where a name that obeys it first comes into
 * existence. Create mode cuts `build/<number>-<slug>-<nonce>` off `FETCH_HEAD` — never a local
 * `origin/main`, which can predate the base the lane needs (#1920 / #3621). Resume mode checks the
 * PR's head branch out under the **local** name `build/pr-<pr>-<nonce>` with its upstream pointed at
 * the remote head, so `build push` updates the PR while the local name carries *this* repair claim's
 * nonce — which is what stops a dead earlier lane from pinning this one (#4868's class).
 *
 * `--resume-lane` is resume mode for the one artifact with no PR to resume — an epic child
 * (ADR 0285). It re-keys the branch a prior lane built the child on to this claim's nonce rather than
 * cutting a second one off it, because two branches carrying one child's commits is the underivable
 * range `lane prove` refuses on, and that refusal cannot be cleared from inside a worktree (#6386).
 *
 * A re-run is idempotent: the nonce is a function of the claim, so the second run resolves the same
 * name and switches to it instead of failing on a branch that is already there.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {localBranches} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {requireCallerToken, requireClaim, requireSession} from "./claim.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {branchExists, fetchBase, renameBranch, setUpstream, switchTo, switchToNew} from "./git.ts";
import {getPullHead} from "./github.ts";
import {
	childLaneBranches,
	createBranchName,
	isKebabSlug,
	parseLaneBranch,
	resumeBranchName,
} from "./lane.ts";
import {resolveTargetRepo} from "./target.ts";
import {assertGround} from "./tree.ts";

const VERB = "build branch";

export interface BranchOptions {
	/** Create mode: the claimed issue the branch serves. `null` in resume mode. */
	readonly number: number | null;
	readonly slug: string | null;
	readonly base: string;
	/** Resume mode: the PR whose head branch to publish back to. Exclusive with `number`. */
	readonly resume: number | null;
	/**
	 * Child-repair mode: take over the branch a prior lane already built `number` on.
	 *
	 * The counterpart of `--resume` for the one artifact that has no PR to resume — an epic child
	 * (ADR 0285). It takes `<number>` rather than a PR, needs no `--slug` because the branch already
	 * carries one, and re-keys that branch to this claim's nonce instead of cutting a second one.
	 */
	readonly resumeLane: boolean;
	/** The token `build claim` handed this lane — the identity it cuts the branch under (#6037). */
	readonly token: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Check the branch out, whether or not it already exists — the idempotent half. */
const checkout = (name: string, start: string) =>
	Effect.gen(function* () {
		return (yield* branchExists(name)) ? yield* switchTo(name) : yield* switchToNew(name, start);
	});

export const runBranch = (
	options: BranchOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {number, slug, resume, resumeLane} = options;
		if ((number === null) === (resume === null)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: give either <number> --slug <slug> or --resume <pr>, never both and never neither.`,
			);
		}
		if (resumeLane && resume !== null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --resume-lane takes over the local branch of an epic child, which has no PR — it cannot be combined with --resume <pr>.`,
			);
		}
		if (resumeLane && slug !== null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --resume-lane reads the slug off the branch it takes over — drop --slug "${slug}".`,
			);
		}
		if (resume === null && !resumeLane && (slug === null || !isKebabSlug(slug))) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --slug "${slug ?? ""}" is not kebab-case (lowercase letters, digits, single hyphens, ≤5 words).`,
			);
		}

		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const ground = yield* assertGround(VERB, false);
		if (ground._tag === "Refused") return ground.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const asking = requireCallerToken(VERB, session.id, options.token);
		if (asking._tag === "Refused") return asking.outcome;
		const caller = asking.caller;

		const claimed = resume ?? (number as number);
		const held = yield* requireClaim(VERB, repo, claimed, caller);
		if (held._tag === "Refused") return held.outcome;
		// Proven by the claim read above to name the lane that holds the number — the winning marker's
		// nonce on the ordinary path, the adopt's on a succession, where the dead lane's nonce is never
		// inherited (ADR 0295). Either way the branch cannot be named after a token that holds
		// nothing (#6037), and a successor's branch is its own, not the dead lane's.
		const nonce = caller.nonce;

		if (resume !== null) {
			const head = yield* getPullHead(repo, resume);
			if (head._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read PR #${resume}: ${head.reason} — nothing was checked out.`,
					held.notes,
				);
			}
			if (head._tag === "Absent" || head.value.state !== "open" || head.value.merged) {
				return refuse(
					ZERO_SCOPE,
					`${VERB}: PR #${resume} is proven closed or merged — nothing to resume.`,
					held.notes,
				);
			}
			const fetched = yield* fetchBase(`origin/${head.value.ref}`);
			if (fetched._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot fetch origin/${head.value.ref}: ${fetched.reason} — refusing to cut a branch off a stale base.`,
					held.notes,
				);
			}
			const name = resumeBranchName(resume, nonce);
			const switched = yield* checkout(name, fetched.value);
			if (switched._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot check out ${name}: ${switched.reason} — nothing was changed.`,
					held.notes,
				);
			}
			const upstream = yield* setUpstream(name, "origin", head.value.ref);
			return upstream._tag === "Failure"
				? refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: ${name} is checked out but its upstream could not be set to origin/${head.value.ref}: ${upstream.reason} — a push would not reach PR #${resume}.`,
						held.notes,
					)
				: answer(name, held.notes);
		}

		if (resumeLane) {
			const issue = number as number;
			const branches = yield* localBranches;
			if (branches._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read this tree's local branches: ${branches.reason} — which branch carries #${issue}'s build is UNKNOWN; nothing was changed.`,
					held.notes,
				);
			}
			const candidates = childLaneBranches(issue, branches.value);
			const [only, ...rest] = candidates;
			if (only === undefined) {
				return refuse(
					ZERO_SCOPE,
					`${VERB}: no local branch in this tree was cut for #${issue} — the build to resume is not here. A child's branch is never pushed (ADR 0285), so it exists only in the tree that built it; resume from that tree, or claim #${issue} without --resume once its FAIL is retracted.`,
					held.notes,
				);
			}
			if (rest.length > 0) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: ${candidates.join(", ")} were all cut for #${issue} — which one this lane resumes is not derivable here; retire the superseded branches, then re-run.`,
					held.notes,
				);
			}
			const prior = parseLaneBranch(only);
			if (prior === null || prior._tag !== "Create") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: "${only}" does not parse back into a lane branch — nothing was changed.`,
					held.notes,
				);
			}
			const name = createBranchName(issue, prior.slug, nonce);
			// Re-keyed in place rather than cut off `only`, so exactly one branch keeps naming this
			// child — two is the underivable range `lane prove` refuses on, and an idempotent re-run
			// under the same nonce resolves the same name and has nothing to rename.
			if (name !== only) {
				const renamed = yield* renameBranch(only, name);
				if (renamed._tag === "Failure") {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot re-key ${only} to ${name}: ${renamed.reason} — the prior lane's worktree is likely still standing on it, and only an operator can release that; nothing was changed.`,
						held.notes,
					);
				}
			}
			const switched = yield* switchTo(name);
			return switched._tag === "Failure"
				? refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot check out ${name}: ${switched.reason} — nothing was changed.`,
						held.notes,
					)
				: answer(name, [
						...held.notes,
						`${VERB}: took over ${only} as ${name} — #${issue}'s build continues on the commits it already carries.`,
					]);
		}

		const fetched = yield* fetchBase(options.base);
		if (fetched._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot fetch ${options.base}: ${fetched.reason} — refusing to cut a branch off a stale base.`,
				held.notes,
			);
		}
		const name = createBranchName(number as number, slug as string, nonce);
		const switched = yield* checkout(name, fetched.value);
		return switched._tag === "Failure"
			? refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot cut ${name} off ${options.base}: ${switched.reason} — nothing was changed.`,
					held.notes,
				)
			: answer(name, held.notes);
	});
