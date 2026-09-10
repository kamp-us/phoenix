/**
 * `build branch` — cut, or resume, the lane's nonce branch off a **freshly fetched** base.
 *
 * The lane-identity rule lives in `lane.ts`; this verb is where a name that obeys it first comes into
 * existence. Create mode cuts `build/<number>-<slug>-<nonce>` off `FETCH_HEAD` — never a local
 * `origin/main`, which can predate the base the lane needs. **Which base that is, create mode
 * derives**: an epic child is cut off its run's assembly branch `epic/<parent>` and a standalone
 * issue off the trunk, with an explicit `--base` honoured verbatim over either — see
 * {@link resolveBase} for the silent wrong base that derivation removes. Resume mode checks the
 * PR's head branch out under the **local** name `build/pr-<pr>-<nonce>` with its upstream pointed at
 * the remote head, so `build push` updates the PR while the local name carries *this* repair claim's
 * nonce — which is what stops a dead earlier lane from pinning this one.
 *
 * `--resume-lane` is resume mode for the one artifact with no PR to resume — an epic child. It
 * re-keys the branch a prior lane built the child on to this claim's nonce rather than
 * cutting a second one off it, because two branches carrying one child's commits is the underivable
 * range `lane prove` refuses on, and that refusal cannot be cleared from inside a worktree.
 *
 * A re-run is idempotent, **and proves the base before it takes the shortcut**: the nonce is a
 * function of the claim, so the second run resolves the same name — and then reads that branch's
 * merge base with the base it just fetched, refusing on `36` unless the branch carries it. Switching
 * blind is what made the idempotent re-run unable to be the recovery for a wrong first cut. Either
 * way create mode names the base commit it ended on, so a builder proves the cut off this verb's own
 * output rather than off a `git merge-base` of their own.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {localBranches} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {epicBranch} from "../wire/lane-brief.ts";
import {requireCallerToken, requireClaim, requireSession} from "./claim.ts";
import {BASE_MISMATCH, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {
	type BaseRef,
	baseLabel,
	branchExists,
	classifyBase,
	currentBranch,
	fetchBase,
	mergeBaseOf,
	remoteSha,
	renameBranch,
	setUpstream,
	switchTo,
	switchToNew,
	worktreeCheckouts,
} from "./git.ts";
import {getParent, getPullHead} from "./github.ts";
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
	/**
	 * The base ref an operator named, honoured verbatim on every lane. `null` is "nobody passed one",
	 * which is what lets the create path derive an epic child's assembly base instead — the two used
	 * to be one value, and `origin/main` was then indistinguishable from a deliberate trunk cut.
	 */
	readonly base: string | null;
	/** Resume mode: the PR whose head branch to publish back to. Exclusive with `number`. */
	readonly resume: number | null;
	/**
	 * Child-repair mode: take over the branch a prior lane already built `number` on.
	 *
	 * The counterpart of `--resume` for the one artifact that has no PR to resume — an epic child. It
	 * takes `<number>` rather than a PR, needs no `--slug` because the branch already
	 * carries one, and re-keys that branch to this claim's nonce instead of cutting a second one.
	 */
	readonly resumeLane: boolean;
	/** The token `build claim` handed this lane — the identity it cuts the branch under. */
	readonly token: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** The trunk a lane with no parent epic and no operator-named base is cut from. */
const TRUNK: BaseRef = {_tag: "Remote", remote: "origin", ref: "main"};

type ResolvedBase =
	| {readonly _tag: "Resolved"; readonly base: BaseRef; readonly note: string}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * Which base the create path cuts off, and where that answer came from.
 *
 * An epic child's commits belong on the run's assembly branch, and the verb derives that itself
 * rather than trusting a builder to pass `--base epic/<n>` — the omission is silent, and a child cut
 * off the trunk is graded against a fork point the assembly branch does not contain, which surfaces
 * at integrate as a conflict or as a clean merge that drops a sibling's work. Both endpoints are
 * derived the way `readAssembly` derives them: the parent from GitHub's own parent endpoint, the
 * branch name from that number through {@link epicBranch}.
 *
 * Every arm is proven. A parent read that failed refuses rather than falling back to the trunk,
 * because that fallback IS the silent wrong base. A derived branch that exists nowhere is a proven
 * `7`, split from the unreadable `11` rather than fused into one message.
 */
const resolveBase = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	issue: number,
	named: string | null,
): Effect.Effect<
	ResolvedBase,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		if (named !== null) {
			const classified = yield* classifyBase(named);
			return classified._tag === "Failure"
				? {
						_tag: "Refused" as const,
						outcome: refuse(
							OFF_VOCABULARY,
							`${VERB}: --base ${classified.reason}. Nothing was cut.`,
						),
					}
				: {
						_tag: "Resolved" as const,
						base: classified.value,
						note: `${VERB}: base ${baseLabel(classified.value)} — named by the operator with --base; no epic derivation ran.`,
					};
		}
		const parent = yield* getParent(env, repo, issue);
		if (parent._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read #${issue}'s parent through GitHub's issue-parent endpoint: ${parent.reason} — whether this is an epic child is UNKNOWN, and cutting off ${baseLabel(TRUNK)} anyway is exactly the silent wrong base this derivation exists to remove. No branch was cut; pass --base to name one yourself.`,
				),
			};
		}
		if (parent._tag === "Absent") {
			return {
				_tag: "Resolved" as const,
				base: TRUNK,
				note: `${VERB}: base ${baseLabel(TRUNK)} — #${issue} is proven standalone (its parent endpoint answered 404), so no epic base was derived.`,
			};
		}
		const assembly = epicBranch(parent.value);
		const published = yield* remoteSha("origin", assembly);
		if (published._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: #${issue} is a child of epic #${parent.value}, and whether origin carries its assembly branch ${assembly} could not be read: ${published.reason} — which base this child belongs on is UNKNOWN. Nothing was cut.`,
				),
			};
		}
		if (published.value === null && !(yield* branchExists(assembly))) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					ZERO_SCOPE,
					`${VERB}: #${issue} is a child of epic #${parent.value}, whose assembly branch ${assembly} is proven absent — origin holds no refs/heads/${assembly} and neither does this clone. Place the run's branch with "fabrika lane assembly ${parent.value}" before building a child on it. Nothing was cut.`,
				),
			};
		}
		// `LocalOnly` is constructible only here, and only past the `remoteSha` read above proving
		// origin carries no `refs/heads/<assembly>` — the one case where reading the local ref cannot
		// be reading a stale copy, because there is no published tip for it to be behind.
		const base: BaseRef =
			published.value === null
				? {_tag: "LocalOnly", ref: assembly}
				: {_tag: "Remote", remote: "origin", ref: assembly};
		return {
			_tag: "Resolved" as const,
			base,
			note: `${VERB}: base ${baseLabel(base)} — derived from #${issue}'s parent epic #${parent.value}; --base was not given.`,
		};
	});

/**
 * Check the branch out, whether or not it already exists — resume mode's idempotent half.
 *
 * Create mode does not use this: it proves an existing branch carries the base it resolved before it
 * switches, and a blind switch there is the wrong base surviving its own re-run.
 */
const checkout = (name: string, start: string) =>
	Effect.gen(function* () {
		return (yield* branchExists(name)) ? yield* switchTo(name) : yield* switchToNew(name, start);
	});

export const runBranch = (
	options: BranchOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
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
		// inherited. Either way the branch cannot be named after a token that holds
		// nothing, and a successor's branch is its own, not the dead lane's.
		const nonce = caller.nonce;

		if (resume !== null) {
			const head = yield* getPullHead(options.env, repo, resume);
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
			const fetched = yield* fetchBase({_tag: "Remote", remote: "origin", ref: head.value.ref});
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
					`${VERB}: cannot read this clone's local branches: ${branches.reason} — which branch carries #${issue}'s build is UNKNOWN; nothing was changed.`,
					held.notes,
				);
			}
			const candidates = childLaneBranches(issue, branches.value);
			const [only, ...rest] = candidates;
			if (only === undefined) {
				return refuse(
					ZERO_SCOPE,
					`${VERB}: no branch anywhere in this clone's refs was cut for #${issue} — the build to resume is gone. Refs are shared across every worktree of a clone, so no other tree here holds one either; a child's branch is never pushed, so it survives only in the clone that built it. Resume from that clone, or claim #${issue} without --resume once its FAIL is retracted.`,
					held.notes,
				);
			}
			if (rest.length > 0) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: ${candidates.join(", ")} were all cut for #${issue} — which one this lane resumes is not derivable here; retire the superseded branches with "fabrika build retire-branch ${issue}", which renames them out of build/ without deleting anything, then re-run.`,
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
			const rekeying = name !== only;
			if (rekeying) {
				// The rename is proven safe BEFORE it runs, because `git branch -m` does not refuse a
				// branch another worktree holds — it renames it and retargets that worktree's HEAD, and
				// only the switch below then fails. Asking git afterwards would
				// mean reporting a mutation that already landed under someone else's lane.
				const checkouts = yield* worktreeCheckouts;
				if (checkouts._tag === "Failure") {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot read which worktree holds ${only}: ${checkouts.reason} — re-keying it could silently retarget another lane's HEAD, so whether the take-over is safe is UNKNOWN; nothing was changed.`,
						held.notes,
					);
				}
				const mine = yield* currentBranch;
				if (mine._tag === "Failure") {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot read which branch this tree holds: ${mine.reason} — whether ${only} is held here or by another lane is UNKNOWN; nothing was changed.`,
						held.notes,
					);
				}
				const holder =
					mine.value === only
						? undefined
						: checkouts.value.find((checkout) => checkout.branch === only);
				if (holder !== undefined) {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: ${only} is checked out in the worktree ${holder.path}, so re-keying it here would rename the branch out from under that lane rather than fail — retiring or releasing that worktree is an operator's act, not this lane's. Nothing was changed.`,
						held.notes,
					);
				}
				const renamed = yield* renameBranch(only, name);
				if (renamed._tag === "Failure") {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot re-key ${only} to ${name}: ${renamed.reason} — nothing was changed.`,
						held.notes,
					);
				}
			}
			const switched = yield* switchTo(name);
			return switched._tag === "Failure"
				? refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot check out ${name}: ${switched.reason} — ${
							rekeying
								? `${only} WAS re-keyed to ${name} and that rename stands; this tree is still on the branch it started on, so re-run once ${name} is free, or rename it back`
								: "nothing was changed"
						}.`,
						held.notes,
					)
				: answer(name, [
						...held.notes,
						`${VERB}: took over ${only} as ${name} — #${issue}'s build continues on the commits it already carries.`,
					]);
		}

		const issue = number as number;
		const resolvedBase = yield* resolveBase(options.env, repo, issue, options.base);
		if (resolvedBase._tag === "Refused")
			return {...resolvedBase.outcome, stderr: [...held.notes, ...resolvedBase.outcome.stderr]};
		const {base} = resolvedBase;
		const notes = [...held.notes, resolvedBase.note];

		const label = baseLabel(base);

		const fetched = yield* fetchBase(base);
		if (fetched._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot fetch ${label}: ${fetched.reason} — refusing to cut a branch off a stale base.`,
				notes,
			);
		}
		const at = fetched.value;
		const name = createBranchName(issue, slug as string, nonce);

		if (yield* branchExists(name)) {
			const shared = yield* mergeBaseOf(at, `refs/heads/${name}`);
			if (shared._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: ${name} already exists and what it was cut from could not be read: ${shared.reason} — whether it carries ${label} is UNKNOWN; nothing was changed.`,
					notes,
				);
			}
			if (shared.value !== at) {
				return refuse(
					BASE_MISMATCH,
					`${VERB}: ${name} already exists and does not carry ${label} at ${at} — the two share only ${shared.value}, so this branch was cut off a different base, or ${label} has moved since it was cut. Rebase it onto ${label}, or retire it with "fabrika build retire-branch ${issue}" and re-run. Nothing was changed.`,
					notes,
				);
			}
			const switched = yield* switchTo(name);
			return switched._tag === "Failure"
				? refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot check out ${name}: ${switched.reason} — nothing was changed.`,
						notes,
					)
				: answer(name, [
						...notes,
						`${VERB}: ${name} already existed and carries ${label} at ${at} — re-run is idempotent, nothing was cut.`,
					]);
		}

		const switched = yield* switchToNew(name, at);
		return switched._tag === "Failure"
			? refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot cut ${name} off ${label}: ${switched.reason} — nothing was changed.`,
					notes,
				)
			: answer(name, [...notes, `${VERB}: cut ${name} off ${label} at ${at}.`]);
	});
