/**
 * `build retire-branch` — clear the two-branch deadlock on an epic child by renaming the superseded
 * lane branches out of `build/`.
 *
 * The residue this clears is #6296 / #6298: two local branches both carry one child's commits,
 * `traceRange` answers `Many`, `locateRange` maps that to `Ambiguous`, and `lane prove` refuses
 * because which range the lane built is not derivable. `build branch --resume-lane` already printed
 * the remedy and nothing performed it. ADR 0324 is the ruling; this is the verb.
 *
 * The order is the contract:
 *
 *   1. This clone's local branches are read, and `childLaneBranches` (`./lane.ts`, never a second
 *      regex) nominates exactly the candidate set `locateRange` nominates.
 *   2. Fewer than two candidates is not a deadlock: zero is `ZERO_SCOPE`, one answers `none`.
 *   3. The board's authorized claim markers are read once, and {@link supersede} seats the
 *      candidates against them. **Nothing is renamed on an `Unattested`** — a survivor nobody
 *      attests to would be a guess, and a wrong guess moves the only copy of a child's work.
 *   4. Stale worktree registrations are pruned, and no branch about to be renamed may be checked
 *      out anywhere. `renameBranch` (`./git.ts`) exits 0 on a held branch and silently retargets
 *      that worktree's `HEAD`, so skipping this proof is destructive in the one way ADR 0324 bans.
 *   5. Each superseded branch is renamed into `retired/`. **No path here deletes a branch** — the
 *      commits survive, and a mistaken retirement costs a rename back rather than the work.
 *   6. Every rename is read back off a second `localBranches` — a retirement this verb reports is
 *      one it proved, never one `git` exited 0 on.
 *
 * A worktree-isolated lane may run it against a branch it never cut: every step is a read or a
 * rename in the shared ref store, and refs are common to every worktree of a clone.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {localBranches} from "../io/git.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {readClaimants} from "./claim.ts";
import {
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SURVIVOR_UNATTESTED,
	WORKTREE_HELD,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {pruneWorktrees, renameBranch, worktreeCheckouts} from "./git.ts";
import {childLaneBranches} from "./lane.ts";
import {sessionsByNonce} from "./retire.ts";
import {retiredBranchName, supersede} from "./retire-branch.ts";
import {badNumber, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "fabrika build retire-branch";

export interface RetireBranchOptions {
	/** The epic child whose lane branches are in the two-branch state. */
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

type Deps = ChildProcessSpawner.ChildProcessSpawner;

interface Retired {
	readonly from: string;
	readonly to: string;
}

export const runRetireBranch = (
	options: RetireBranchOptions,
): Effect.Effect<VerbOutcome, never, Deps> =>
	Effect.gen(function* () {
		const {number} = options;
		const bad = badNumber(VERB, "an issue number", number);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const {repo} = resolved;

		const branches = yield* localBranches;
		if (branches._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read this clone's local branches: ${branches.reason} — which branches were cut for #${number} is UNKNOWN; nothing was renamed.`,
			);
		}
		const candidates = childLaneBranches(number, branches.value);
		const scope = scannedLine(
			VERB,
			branches.value.length,
			"local branch",
			`${candidates.length} cut for #${number}`,
		);
		if (candidates.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: no branch in this clone's refs was cut for #${number} — there is no lane branch to retire.`,
				[scope],
			);
		}
		if (candidates.length === 1) {
			return answer(
				JSON.stringify({answer: "none", number, survivor: candidates[0], retired: []}),
				[
					scope,
					`${VERB}: ${candidates[0]} is the only branch cut for #${number} — the range is already derivable, and nothing is superseded.`,
				],
			);
		}

		const claimants = yield* readClaimants(repo, number);
		if (claimants._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the claim markers on #${number}: ${claimants.reason} — which branch a live lane cut is UNKNOWN, never "none of them"; nothing was renamed.`,
				[scope],
			);
		}
		const seated = supersede(number, candidates, sessionsByNonce(claimants.claimants));
		if (seated._tag === "Unattested") {
			return refuse(
				SURVIVOR_UNATTESTED,
				`${VERB}: ${seated.why} — nothing was renamed, because a survivor picked without an attestation is a guess, and a child's branch is the only copy of its work (ADR 0324).`,
				[scope],
			);
		}

		const pruned = yield* pruneWorktrees;
		if (pruned._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot prune this clone's worktree registrations: ${pruned.reason} — which trees hold #${number}'s lane branches is UNKNOWN; nothing was renamed.`,
				[scope],
			);
		}
		const checkouts = yield* worktreeCheckouts;
		if (checkouts._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read which working tree holds what: ${checkouts.reason} — whether one holds a branch about to be renamed is UNKNOWN; nothing was renamed.`,
				[scope],
			);
		}
		const held = checkouts.value.filter((checkout) => seated.superseded.includes(checkout.branch));
		const [first] = held;
		if (first !== undefined) {
			return refuse(
				WORKTREE_HELD,
				`${VERB}: ${held.map((row) => `${row.path} holds ${row.branch}`).join("; ")} — git renames a held branch without refusing and silently retargets that tree's HEAD, so nothing was renamed. Take that checkout back first: fabrika build retire ${number}.`,
				[scope],
			);
		}

		const retired: Array<Retired> = [];
		for (const from of seated.superseded) {
			const to = retiredBranchName(from);
			if (to === null) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: "${from}" is not in the build/ namespace, so there is no name to retire it to — nothing further was renamed.`,
					[scope],
				);
			}
			const renamed = yield* renameBranch(from, to);
			if (renamed._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: git refused to rename ${from} to ${to}: ${renamed.reason} — whether that branch moved is UNKNOWN. ${retired.length} branch(es) were retired before it.`,
					[scope],
				);
			}
			retired.push({from, to});
		}

		const after = yield* localBranches;
		if (after._tag === "Failure") {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: ${retired.length} branch(es) were renamed and this clone's branches could not be read back: ${after.reason} — the retirement is NOT proven.`,
				[scope],
			);
		}
		const unproven = retired.find(
			(row) => after.value.includes(row.from) || !after.value.includes(row.to),
		);
		if (unproven !== undefined) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: git reported ${unproven.from} renamed to ${unproven.to} and the read-back disagrees — the retirement is NOT proven, and this clone needs a human.`,
				[scope],
			);
		}

		return answer(JSON.stringify({answer: "retired", number, survivor: seated.survivor, retired}), [
			scope,
			...retired.map(
				(row) =>
					`${VERB}: retired ${row.from} — renamed to ${row.to}, never deleted, so every commit it carries is still reachable by that name.`,
			),
			`${VERB}: ${seated.survivor} is the survivor — an authorized claim marker on #${number} carries its lane nonce.`,
		]);
	});
