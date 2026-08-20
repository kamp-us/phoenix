/**
 * `build eligible` — one issue's dependency gate, **derived from GitHub's native `blocked_by` graph
 * and nothing else** (#5913). A label is a claim and a prose block is a rendering; the graph is the
 * fact (#5387, ADR 0301).
 *
 * The edges are the issue's own, so the gate no longer hangs off a parent ledger: a standalone
 * issue is gated exactly like an epic child, which is the population ADR 0301 extended the rule to.
 * The parent is still resolved, because the assembly-branch discharge below is named from it and
 * the answer carries it.
 *
 * Three outcomes and no fourth: `eligible` on stdout, **every** open blocker on `16`, and UNKNOWN on
 * `11`. An edge list that could not be read is `11` — "no edges found" is never read as "not
 * blocked", and the whole derivation lives in [`./blockedness.ts`](./blockedness.ts), the one reader
 * over that one source.
 *
 * **A blocker is discharged by a closed issue OR by a landed commit** (`./landed.ts`, #6063). Under
 * ADR 0285 an epic run's children stay open until the single tail PR merges, so inside a run the
 * closed-state proxy answers "is the issue closed" where the gate means "did the work land" — and
 * reading only the first makes every later-phase child unbuildable until the epic it blocks has
 * shipped. The second source is evidence, not a skip: no assembly branch, no discharge — and the
 * evidence is only what the run added over the trunk, never the history the branch was cut from.
 *
 * **Every blocker is read before the answer is seated, so the answer does not depend on the order
 * the graph happens to list them in.** One *proven* open edge is proof of blockedness whatever else
 * could not be read, so a blocker read that failed alongside it downgrades neither the verdict nor
 * its edge list — it is named on stderr as its own unread row instead. With nothing proven open, an
 * unread blocker is `11`: the set of blocking edges is only complete when every blocker's state is
 * known.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {readBlockedness} from "./blockedness.ts";
import {BLOCKED, PRECONDITION_UNKNOWN} from "./codes.ts";
import {getParent} from "./github.ts";
import {type Assembly, readAssembly} from "./landed.ts";
import {openIssue, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "build eligible";

/** One edge the board did not discharge, and the blocker it names. */
interface Edge {
	readonly number: number;
	readonly text: string;
}

/** What the assembly-branch read added to the answer, said on stderr so the upgrade is auditable. */
const assemblyNotes = (
	assembly: Assembly | null,
	discharged: ReadonlyArray<Edge>,
): ReadonlyArray<string> => {
	if (assembly === null) return [];
	if (assembly._tag === "Unreadable") {
		return [
			`${VERB}: cannot read ${assembly.branch} in this tree: ${assembly.reason} — no edge is counted discharged off it, and every edge keeps the state the board gave it.`,
		];
	}
	const range = `${assembly.baseRef}..${assembly.branch}`;
	return discharged.length === 0
		? [`${VERB}: ${range} adds ${assembly.commits} commit(s), none naming an undischarged blocker.`]
		: [
				`${VERB}: ${range} adds a commit naming ${discharged.map((edge) => `#${edge.number}`).join(", ")} — that work landed on the epic run's assembly branch, so the edge is discharged whatever the board says about the issue (ADR 0285).`,
			];
};

export interface EligibleOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runEligible = (
	options: EligibleOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const {number} = options;
		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* openIssue(
			VERB,
			repo,
			number,
			(reason) =>
				`${VERB}: cannot read #${number}: ${reason} — eligibility is UNKNOWN, never "eligible".`,
		);
		if (target._tag === "Refused") return target.outcome;

		const parent = yield* getParent(options.env, repo, number);
		if (parent._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the parent of #${number}: ${parent.reason} — eligibility is UNKNOWN, never "eligible".`,
			);
		}
		const epic = parent._tag === "Present" ? parent.value : null;

		const blockedness = yield* readBlockedness(repo, number);
		if (blockedness._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the blocked_by edges of #${number}: ${blockedness.reason} — eligibility is UNKNOWN, never "eligible".`,
			);
		}

		const scope = scannedLine(
			VERB,
			blockedness.scanned,
			"blocked_by edge",
			epic === null ? "standalone" : `parent #${epic}`,
		);
		const open: ReadonlyArray<Edge> = blockedness.open.map((n) => ({
			number: n,
			text: `#${n}`,
		}));
		const unread: ReadonlyArray<Edge> = blockedness.unread.map((row) => ({
			number: row.number,
			text: `${VERB}: cannot read blocker #${row.number}: ${row.reason} — its state is UNKNOWN, never counted closed.`,
		}));

		// The branch is read only when an edge is still undischarged, and only when there is an epic
		// whose assembly branch could carry it — a standalone issue's blockers land nowhere derivable.
		const undischarged = open.length + unread.length > 0;
		const assembly =
			undischarged && epic !== null ? yield* readAssembly(options.env, repo, epic) : null;
		const landed = assembly?._tag === "Read" ? assembly.landed : new Set<number>();
		const carries = (edge: Edge) => landed.has(edge.number);
		const stillOpen = open.filter((edge) => !carries(edge));
		const stillUnread = unread.filter((edge) => !carries(edge));
		const branchNotes = assemblyNotes(assembly, [...open, ...unread].filter(carries));

		const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
		const detail = stillUnread.map((edge) => edge.text);
		if (stillOpen.length > 0) {
			return refuse(
				BLOCKED,
				`${VERB}: blocked by ${plural(stillOpen.length, "open blocked_by edge")}: ${stillOpen.map((edge) => edge.text).join(", ")}.`,
				[scope, ...branchNotes, ...detail],
			);
		}
		if (stillUnread.length > 0) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${plural(stillUnread.length, "blocker")} could not be read — eligibility is UNKNOWN, never "eligible".`,
				[scope, ...branchNotes, ...detail],
			);
		}

		return answer(JSON.stringify({answer: "eligible", number, parent: epic}), [
			scope,
			...branchNotes,
		]);
	});
