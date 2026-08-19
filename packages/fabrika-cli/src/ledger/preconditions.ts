/**
 * The four preconditions every `ledger` verb runs before it answers, in one place so six copies cannot
 * drift apart: resolve the repo, refuse a target that is not a `type:epic`, read the tree root the run
 * directory hangs off, and prove this session holds the epic's claim.
 *
 * The claim is the **`build` group's, reused as landed verbs** — no second lock is derived. v1's
 * `epic-lock` is why: all five of its distinct outcomes collapsed onto exit `1`, it wrote the
 * `status:planning` label *before* the claim comment so a failed claim left a held label with no owner,
 * and its release re-found "our own" claim by session id, so a sibling lane's release retracted the
 * holder's claim.
 *
 * The run directory is derived from the **claim nonce** here and nowhere else, which is what makes two
 * parallel planning lanes of one session independent (#4516, #4544, #4500). That independence is why
 * the claim is proven against the `--token` this lane holds rather than against its session id: under
 * the session-only rule a lane that had *lost* the epic's claim still read the holder's marker as its
 * own, and derived the holder's run key from it, so both lanes wrote into one directory (#6060).
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {requireCallerToken, requireClaim, requireSession} from "../build/claim.ts";
import {nonceOf} from "../build/lane.ts";
import {badNumber, openIssue, resolveTargetRepo} from "../build/target.ts";
import {assertGround} from "../build/tree.ts";
import type {IssueRecord} from "../io/issues.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {CLAIM_NOT_MINE, OFF_VOCABULARY, PRECONDITION_UNKNOWN} from "./codes.ts";
import {runDir, runKey} from "./run.ts";

export const EPIC_LABEL = "type:epic";

/** The per-verb halves of the shared refusals — the same facts, each verb's own wording. */
export interface LedgerMessages {
	readonly verb: string;
	/** `<verb>: #<n> is not a type:epic — <tail>.` */
	readonly notAnEpic: (epic: number) => string;
	/** `<verb>: cannot read <what>: <reason> — <tail>.` */
	readonly unreadable: (what: string, reason: string) => string;
}

export interface Ground {
	readonly repo: string;
	readonly epic: IssueRecord;
	readonly treeRoot: string;
	/** `<epic>-<claim-nonce>` — the run's name, and the leaf of its directory. */
	readonly run: string;
	readonly dir: string;
	readonly notes: ReadonlyArray<string>;
}

export type Opened =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| ({readonly _tag: "Ground"} & Ground);

export interface OpenOptions {
	readonly number: number;
	/** The claim token `build claim <epic> --purpose plan` handed this lane — which lane is asking. */
	readonly token: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const refused = (outcome: VerbOutcome): Opened => ({_tag: "Refused", outcome});

export const openGround = (
	messages: LedgerMessages,
	options: OpenOptions,
): Effect.Effect<Opened, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {verb} = messages;
		const epicNumber = options.number;

		const bad = badNumber(verb, "an issue number", epicNumber);
		if (bad !== null) return refused(bad);

		const session = requireSession(verb, options.env);
		if (session._tag === "Refused") return refused(session.outcome);

		const asking = requireCallerToken(verb, session.id, options.token);
		if (asking._tag === "Refused") return refused(asking.outcome);

		const resolved = yield* resolveTargetRepo(verb, options.repo, options.env);
		if (resolved._tag === "Refused") return refused(resolved.outcome);
		const repo = resolved.repo;

		const target = yield* openIssue(verb, repo, epicNumber, (reason) =>
			messages.unreadable(`#${epicNumber}`, reason),
		);
		if (target._tag === "Refused") return refused(target.outcome);
		if (!target.issue.labels.includes(EPIC_LABEL)) {
			return refused(refuse(OFF_VOCABULARY, messages.notAnEpic(epicNumber)));
		}

		const tree = yield* assertGround(verb, false);
		if (tree._tag === "Refused") return refused(tree.outcome);

		const held = yield* requireClaim(verb, repo, epicNumber, asking.caller);
		if (held._tag === "Refused") {
			const outcome = held.outcome;
			return refused(
				outcome.code === CLAIM_NOT_MINE
					? refuse(
							CLAIM_NOT_MINE,
							`${verb}: this lane does not hold #${epicNumber}'s claim.`,
							outcome.stderr,
						)
					: outcome,
			);
		}

		const nonce = nonceOf(held.marker.token);
		if (nonce === null) {
			return refused(
				refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: the claim on #${epicNumber} carries the token ${held.marker.token}, which yields no lane nonce — the run key is UNKNOWN.`,
					held.notes,
				),
			);
		}

		const run = runKey(epicNumber, nonce);
		return {
			_tag: "Ground",
			repo,
			epic: target.issue,
			treeRoot: tree.root,
			run,
			dir: runDir(tree.root, run),
			notes: held.notes,
		};
	});
