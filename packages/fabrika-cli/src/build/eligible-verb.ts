/**
 * `build eligible` — one issue's dependency gate, **derived from the parent's topology, never read off
 * a label**. A label is a claim; the topology is the fact (#4104, #4920).
 *
 * Three outcomes and no fourth: `eligible` on stdout, **every** named blocking edge on `16`, and
 * UNKNOWN on `11`. A parent whose `## Dependencies` block is absent or unparseable is `4` — "no
 * parseable edges" is never read as "no edges", because a topology nobody could read proves nothing
 * about blockedness.
 *
 * A ledger-local ref (`C<int>`) names a child that has not been filed yet, so it blocks: unfiled work
 * is open work, and the alternative — treating it as satisfied — is the fail-open this verb exists to
 * remove.
 *
 * **A predecessor is discharged by closed issue OR by landed commit** (`./landed.ts`, #6063). Under
 * ADR 0285 an epic run's children stay open until the single tail PR merges, so inside a run the
 * closed-state proxy answers "is the issue closed" where the gate means "did the work land" — and
 * reading only the first makes every phase-2 child unbuildable until the epic it blocks has shipped.
 * The second source is evidence, not a skip: no assembly branch, no discharge.
 *
 * **Every predecessor is scanned before the answer is seated, so the answer does not depend on the
 * order the topology happens to list them in.** One *proven* open edge is proof of blockedness
 * whatever else could not be read, so a predecessor read that failed alongside it downgrades neither
 * the verdict nor its edge list — it is named on stderr as its own unread row instead. With nothing
 * proven open, an unread predecessor is `11`: the set of blocking edges is only complete when every
 * predecessor's state is known.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {BAD_SECTIONS, BLOCKED, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {gate} from "./content-gate.ts";
import {predecessorsOf, readTopology, renderRef} from "./dependencies.ts";
import {getParent} from "./github.ts";
import {type Assembly, readAssembly} from "./landed.ts";
import {openIssue, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "build eligible";

/**
 * One edge that is not discharged by the board, and the issue it names — `null` for a ledger-local
 * ref, which names no issue a commit could reference and so is never dischargeable off the branch.
 */
interface Edge {
	readonly number: number | null;
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
	return discharged.length === 0
		? [
				`${VERB}: ${assembly.branch} carries ${assembly.commits} commit(s), none naming an undischarged predecessor.`,
			]
		: [
				`${VERB}: ${assembly.branch} carries a commit naming ${discharged.map((edge) => `#${edge.number}`).join(", ")} — that work landed on the epic run's assembly branch, so the edge is discharged whatever the board says about the issue (ADR 0285).`,
			];
};

export interface EligibleOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runEligible = (
	options: EligibleOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
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

		const parent = yield* getParent(repo, number);
		if (parent._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the parent of #${number}: ${parent.reason} — eligibility is UNKNOWN, never "eligible".`,
			);
		}
		if (parent._tag === "Absent") {
			return answer(JSON.stringify({answer: "eligible", number, parent: null}), [
				scannedLine(VERB, 0, "dependency edge", "standalone: no parent ledger to derive from"),
			]);
		}

		const ledger = yield* getIssue(repo, parent.value);
		if (ledger._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read parent #${parent.value}: ${ledger.reason} — eligibility is UNKNOWN, never "eligible".`,
			);
		}
		if (ledger._tag === "Absent") {
			return refuse(ZERO_SCOPE, `${VERB}: parent #${parent.value} is proven absent.`);
		}

		const topology = readTopology(gate("issue-body", `#${parent.value}`, ledger.value.body).text);
		if (topology._tag !== "Parsed") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: parent #${parent.value} has no parseable "## Dependencies" block — eligibility cannot be derived, and "no edges found" is never read as "eligible".`,
				topology._tag === "Unparseable"
					? [`${VERB}: line ${topology.line} does not parse: "${topology.text}".`]
					: [],
			);
		}

		const predecessors = predecessorsOf(topology.edges, {_tag: "Issue", number});
		const scope = scannedLine(
			VERB,
			predecessors.length,
			"dependency edge",
			`parent #${parent.value}`,
		);
		const open: Edge[] = [];
		const unread: Edge[] = [];
		for (const {kind, ref} of predecessors) {
			if (ref._tag === "Local") {
				open.push({number: null, text: `${kind} ${renderRef(ref)} (unfiled, so open)`});
				continue;
			}
			const state = yield* getIssue(repo, ref.number);
			if (state._tag === "Unknown") {
				unread.push({
					number: ref.number,
					text: `${VERB}: cannot read ${kind} predecessor #${ref.number}: ${state.reason} — its state is UNKNOWN, never counted closed.`,
				});
				continue;
			}
			if (state._tag === "Absent" || state.value.state === "open")
				open.push({number: ref.number, text: `${kind} #${ref.number}`});
		}

		const undischarged = [...open, ...unread].some((edge) => edge.number !== null);
		const assembly = undischarged ? yield* readAssembly(parent.value) : null;
		const landed = assembly?._tag === "Read" ? assembly.landed : new Set<number>();
		const carries = (edge: Edge) => edge.number !== null && landed.has(edge.number);
		const stillOpen = open.filter((edge) => !carries(edge));
		const stillUnread = unread.filter((edge) => !carries(edge));
		const branchNotes = assemblyNotes(assembly, [...open, ...unread].filter(carries));

		const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
		const detail = stillUnread.map((edge) => edge.text);
		if (stillOpen.length > 0) {
			return refuse(
				BLOCKED,
				`${VERB}: blocked by ${plural(stillOpen.length, "open dependency edge")}: ${stillOpen.map((edge) => edge.text).join(", ")}.`,
				[scope, ...branchNotes, ...detail],
			);
		}
		if (stillUnread.length > 0) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${plural(stillUnread.length, "predecessor")} could not be read — eligibility is UNKNOWN, never "eligible".`,
				[scope, ...branchNotes, ...detail],
			);
		}

		return answer(JSON.stringify({answer: "eligible", number, parent: parent.value}), [
			scope,
			...branchNotes,
		]);
	});
