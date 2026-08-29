/**
 * The assembly-branch discharge, derived once for every seam that gates on `blocked_by`.
 *
 * [`./blockedness.ts`](./blockedness.ts) reads the board's answer and [`./landed.ts`](./landed.ts)
 * reads the epic run's own commits; this module is the one place the second is allowed to move the
 * first. Under ADR 0285 a child's issue stays open until the single tail PR merges, so inside a run
 * in flight "the blocker is closed" answers a different question from "the blocker's work landed",
 * and only the second is the one a dependency gate means (#6063). ADR 0301's 2026-08-29 amendment is
 * what authorizes that narrowing at both seams.
 *
 * It exists because `build eligible` and the claim seam once each carried their own answer: eligible
 * discharged a landed edge and claim refused it on 16, so every sequential epic tracer after the
 * first parked at a human until someone deleted the graph edge by hand (#7035). `build pick` was the
 * third answer to the same edge — it counted the child `blocked` in its excluded histogram, so a
 * buildable child read as unavailable to anyone reading the pool (#7223).
 *
 * **Discharge moves an answer only toward admitting.** An unreadable branch, an unnameable trunk and
 * a standalone issue all leave every edge exactly as the board read it, so a gate can never admit on
 * evidence it failed to read.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type BlockedGate, type Blockedness, gateOf, readBlockedness} from "./blockedness.ts";
import {getParent} from "./github.ts";
import {type Assembly, readAssembly} from "./landed.ts";

/** A blockedness read that answered — the only shape discharge can subtract from. */
export type BlockednessRead = Extract<Blockedness, {readonly _tag: "Read"}>;

type Seams = ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient;

export interface Discharge {
	/** The board's read, minus every edge the assembly branch carries. */
	readonly remaining: BlockednessRead;
	/** Every blocker the branch discharged, in the order the graph listed them. */
	readonly discharged: ReadonlyArray<number>;
	/** What the branch said, or `null` when nothing made it worth reading. */
	readonly assembly: Assembly | null;
}

/**
 * Subtract what epic `epic`'s assembly branch carries from what the board said.
 *
 * The branch is read only when an edge is still undischarged and there is an epic whose branch could
 * carry it: a standalone issue's blockers land nowhere derivable, and a clear read has nothing to
 * subtract from.
 */
export const dischargeLanded = (
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	epic: number | null,
	read: BlockednessRead,
): Effect.Effect<Discharge, never, Seams> =>
	Effect.gen(function* () {
		const undischarged = read.open.length + read.unread.length > 0;
		if (!undischarged || epic === null)
			return {remaining: read, discharged: [], assembly: null} as const;

		const assembly = yield* readAssembly(env, repo, epic);
		const landed = assembly._tag === "Read" ? assembly.landed : new Set<number>();
		return {
			remaining: {
				...read,
				open: read.open.filter((blocker) => !landed.has(blocker)),
				unread: read.unread.filter((row) => !landed.has(row.number)),
			},
			discharged: [...read.open, ...read.unread.map((row) => row.number)].filter((blocker) =>
				landed.has(blocker),
			),
			assembly,
		};
	});

/** What the assembly-branch read added, said on stderr so the upgrade is auditable at either seam. */
export const assemblyNotes = (verb: string, discharge: Discharge): ReadonlyArray<string> => {
	const {assembly, discharged} = discharge;
	if (assembly === null) return [];
	if (assembly._tag === "Unreadable") {
		return [
			`${verb}: cannot read ${assembly.branch} in this tree: ${assembly.reason} — no edge is counted discharged off it, and every edge keeps the state the board gave it.`,
		];
	}
	const range = `${assembly.baseRef}..${assembly.branch}`;
	return discharged.length === 0
		? [`${verb}: ${range} adds ${assembly.commits} commit(s), none naming an undischarged blocker.`]
		: [
				`${verb}: ${range} adds a commit naming ${discharged.map((blocker) => `#${blocker}`).join(", ")} — that work landed on the epic run's assembly branch, so the edge is discharged whatever the board says about the issue (ADR 0285).`,
			];
};

export interface DischargedGate {
	readonly gate: BlockedGate;
	readonly notes: ReadonlyArray<string>;
}

/**
 * The whole gate for a seam that only needs "may this start" — `build claim` and `build pick`.
 *
 * The parent is resolved lazily, so an issue the board already reads as clear costs exactly what it
 * cost before this discharge existed. That laziness is what lets the pool afford this over a whole
 * board: it pays the parent resolve and the branch read only for the candidates the graph already
 * refused. A parent that could not be read is UNKNOWN rather than
 * blocked: the evidence that would discharge the edge is the thing that went unread, and that is the
 * answer `build eligible` seats on the same failure.
 */
export const readDischargedGate = (
	verb: string,
	env: Readonly<Record<string, string | undefined>>,
	repo: string,
	issue: number,
): Effect.Effect<DischargedGate, never, Seams> =>
	Effect.gen(function* () {
		const read = yield* readBlockedness(repo, issue);
		if (read._tag === "Unknown") return {gate: gateOf(read), notes: []};
		if (read.open.length + read.unread.length === 0) return {gate: gateOf(read), notes: []};

		const parent = yield* getParent(env, repo, issue);
		if (parent._tag === "Unknown") {
			return {
				gate: {
					_tag: "Unknown",
					reason: `the parent of #${issue} could not be read (${parent.reason}), so no assembly branch could discharge the open edge`,
				},
				notes: [],
			};
		}
		const discharge = yield* dischargeLanded(
			env,
			repo,
			parent._tag === "Present" ? parent.value : null,
			read,
		);
		return {gate: gateOf(discharge.remaining), notes: assemblyNotes(verb, discharge)};
	});
