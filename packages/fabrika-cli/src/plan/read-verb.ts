/**
 * `plan read` — fetch the epic and its children, parse the ledger, print it as one object.
 *
 * The fetch and the registered parses, and no judgment: *what the plan is worth* stays in the skill,
 * and *whether it clears the floor* is `plan check`'s. Zero children is a `7` refusal rather than an
 * empty answer — an empty child set is not a clean read of an epic with nothing in it, it is a scope
 * nobody can grade (ADR 0092).
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, resolveTargetRepo} from "../build/target.ts";
import {cycleDocOr} from "../config/paths.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {loadLedger, type PlanMessages, requireEpic, scannedChildren} from "./load.ts";
import {renderTopology} from "./model.ts";

const VERB = "plan read";

export const MESSAGES: PlanMessages = {
	verb: VERB,
	grammar: (reason) => `${VERB}: ${reason}`,
	zeroChildren: (epic) =>
		`${VERB}: #${epic} has zero sub-issue children — there is no ledger to read (ADR 0092).`,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to read it as one.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — the ledger is UNKNOWN.`,
};

export interface ReadOptions {
	readonly number: number;
	readonly repo: string | null;
	/** Where to look for `.fabrika.jsonc` — the checkout this run stands in. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runRead = (
	options: ReadOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", options.number);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* requireEpic(MESSAGES, repo, options.number);
		if (target._tag === "Refused") return target.outcome;

		const cycle = yield* cycleDocOr(
			VERB,
			options.cwd,
			"where the cycle doc lives is unread, so the containment class cannot be derived.",
		);
		if (cycle._tag === "Refused") return refuse(PRECONDITION_UNKNOWN, cycle.message);

		const read = yield* loadLedger(MESSAGES, repo, target.issue, cycle.path);
		if (read._tag === "Refused") return read.outcome;
		const ledger = read.ledger;

		return answer(
			JSON.stringify({
				answer: "read",
				epic: ledger.epic,
				children: ledger.children.map((child) => ({
					number: child.number,
					labels: child.labels,
					assignees: child.assignees,
					assigneesObserved: child.assigneesObserved,
					criteria: child.criteria,
					criteriaCount: child.criteriaCount,
					stories: child.stories,
					containment: child.containment,
				})),
				epicStories: ledger.epicStories,
				cycleDoc: ledger.cycleDoc,
				topology: renderTopology(ledger.topology),
				digest: ledger.digest,
			}),
			[
				scannedChildren(
					VERB,
					ledger.children.map((child) => child.number),
				),
			],
		);
	});
