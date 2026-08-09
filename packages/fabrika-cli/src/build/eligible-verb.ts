/**
 * `build eligible` — one issue's dependency gate, **derived from the parent's topology, never read off
 * a label**. A label is a claim; the topology is the fact (#4104, #4920).
 *
 * Three outcomes and no fourth: `eligible` on stdout, a named blocking edge on `16`, and UNKNOWN on
 * `11`. A parent whose `## Dependencies` block is absent or unparseable is `4` — "no parseable edges"
 * is never read as "no edges", because a topology nobody could read proves nothing about blockedness.
 *
 * A ledger-local ref (`C<int>`) names a child that has not been filed yet, so it blocks: unfiled work
 * is open work, and the alternative — treating it as satisfied — is the fail-open this verb exists to
 * remove.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {getIssue} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {BAD_SECTIONS, BLOCKED, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {gate} from "./content-gate.ts";
import {predecessorsOf, readTopology, renderRef} from "./dependencies.ts";
import {getParent} from "./github.ts";
import {openIssue, resolveTargetRepo, scannedLine} from "./target.ts";

const VERB = "build eligible";

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
		for (const {kind, ref} of predecessors) {
			if (ref._tag === "Local") {
				return refuse(BLOCKED, `${VERB}: blocked by open ${kind} edge ${renderRef(ref)}.`, [
					scope,
					`${VERB}: ${renderRef(ref)} is a ledger-local id — it names work not yet filed, which is open.`,
				]);
			}
			const state = yield* getIssue(repo, ref.number);
			if (state._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read predecessor #${ref.number}: ${state.reason} — eligibility is UNKNOWN, never "eligible".`,
					[scope],
				);
			}
			if (state._tag === "Absent" || state.value.state === "open") {
				return refuse(BLOCKED, `${VERB}: blocked by open ${kind} edge #${ref.number}.`, [scope]);
			}
		}

		return answer(JSON.stringify({answer: "eligible", number, parent: parent.value}), [scope]);
	});
