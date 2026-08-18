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
 * A re-run is idempotent: the nonce is a function of the claim, so the second run resolves the same
 * name and switches to it instead of failing on a branch that is already there.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {requireCallerToken, requireClaim, requireSession} from "./claim.ts";
import {OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {branchExists, fetchBase, setUpstream, switchTo, switchToNew} from "./git.ts";
import {getPullHead} from "./github.ts";
import {createBranchName, isKebabSlug, resumeBranchName} from "./lane.ts";
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
		const {number, slug, resume} = options;
		if ((number === null) === (resume === null)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: give either <number> --slug <slug> or --resume <pr>, never both and never neither.`,
			);
		}
		if (resume === null && (slug === null || !isKebabSlug(slug))) {
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
		// Proven equal to the winning marker's nonce by the claim read above, so the branch cannot be
		// named after a token that holds nothing (#6037).
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
