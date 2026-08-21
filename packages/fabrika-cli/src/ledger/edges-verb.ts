/**
 * `ledger edges` — write the epic's `## Dependencies` block into GitHub's native `blocked_by` graph.
 *
 * ADR [0301](../../../../.decisions/0301-blocked-by-graph-is-the-carrier.md) makes that graph the one
 * carrier of blockedness, and both build gates read only it. A plan whose dependencies live in prose
 * alone therefore admits a child it has already declared blocked — epic #6595 let a child gated behind
 * an open, unruled decision through `build claim` on `scanned 0 blocked_by edges` (#6616). This verb
 * closes that gap by writing the edges the block owes.
 *
 * **It reads the epic's own body, never this run's staged topology**, so it reconciles an epic planned
 * by an earlier run exactly as it reconciles one written a moment ago. The board is what the gates
 * read, so the board is what this compares against.
 *
 * **Reconcile, never replace.** Only missing edges are POSTed; an edge already there is `already` and
 * an edge nobody's plan names is left alone. A `blocked_by` list may carry edges no ledger authored —
 * a human's, another epic's — and deleting one because this block does not name it would silently
 * unblock work on the strength of a document that was never the carrier.
 */

import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type RequiredEdge, readTopology, requiredEdges} from "../build/dependencies.ts";
import {scannedLine} from "../build/target.ts";
import {addBlockedBy, blockedBy, internalId} from "../io/edges.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	BAD_SECTIONS,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	TOPOLOGY_INVALID,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";

const VERB = "ledger edges";

/** Bounded like every other fan in this package — v1 spawned one call per child, unbounded. */
const FAN_OUT = 8;

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) => `${VERB}: #${epic} is not a type:epic — refusing to write edges for it.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was written.`,
};

/** Each dependent's `blocked_by` list, or the refusal the unread one owes. */
type Graph =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Graph"; readonly edges: ReadonlyMap<number, ReadonlySet<number>>};

const readGraph = (
	repo: string,
	dependents: ReadonlyArray<number>,
	/** The refusal an unread list owes — it differs before the writes (nothing written) and after. */
	whenUnread: (what: string, reason: string) => VerbOutcome,
): Effect.Effect<Graph, never, ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const read = yield* Effect.forEach(
			dependents,
			(number) => blockedBy(repo, number).pipe(Effect.map((found) => [number, found] as const)),
			{concurrency: FAN_OUT},
		);
		const edges = new Map<number, ReadonlySet<number>>();
		for (const [number, found] of read) {
			if (found._tag !== "Present") {
				return {
					_tag: "Refused" as const,
					outcome: whenUnread(
						`#${number}'s blocked_by list`,
						found._tag === "Absent"
							? "it answered 404 for an issue the topology names"
							: found.reason,
					),
				};
			}
			edges.set(number, new Set(found.value));
		}
		return {_tag: "Graph" as const, edges};
	});

const missingFrom = (
	graph: ReadonlyMap<number, ReadonlySet<number>>,
	required: ReadonlyArray<RequiredEdge>,
): ReadonlyArray<RequiredEdge> =>
	required.filter((edge) => graph.get(edge.dependent)?.has(edge.prerequisite) !== true);

export const runEdges = (
	options: OpenOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {repo, epic, notes} = ground;

		const topology = readTopology(epic.body);
		if (topology._tag === "Unparseable") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: #${epic.number}'s ## Dependencies block is unparseable at line ${topology.line}: ${topology.text}`,
				notes,
			);
		}
		if (topology._tag === "Absent" || topology.edges.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${epic.number} declares no topology — refusing to answer over zero scope (ADR 0092).`,
				notes,
			);
		}

		const required = requiredEdges(topology.edges);
		const dependents = [...new Set(required.map((edge) => edge.dependent))].sort((a, b) => a - b);
		const scanned = scannedLine(VERB, required.length, "required edge");

		const before = yield* readGraph(repo, dependents, (what, reason) =>
			refuse(PRECONDITION_UNKNOWN, MESSAGES.unreadable(what, reason), notes),
		);
		if (before._tag === "Refused") return before.outcome;
		const missing = missingFrom(before.edges, required);

		const prerequisites = [...new Set(missing.map((edge) => edge.prerequisite))].sort(
			(a, b) => a - b,
		);
		const resolved = yield* Effect.forEach(
			prerequisites,
			(number) => internalId(repo, number).pipe(Effect.map((found) => [number, found] as const)),
			{concurrency: FAN_OUT},
		);
		const ids = new Map<number, number>();
		for (const [number, found] of resolved) {
			if (found._tag === "Absent") {
				return refuse(
					TOPOLOGY_INVALID,
					`${VERB}: #${number} is named as a prerequisite and is proven absent — no edge can point at it.`,
					[...notes, scanned],
				);
			}
			if (found._tag === "Unknown") {
				return refuse(PRECONDITION_UNKNOWN, MESSAGES.unreadable(`#${number}`, found.reason), [
					...notes,
					scanned,
				]);
			}
			ids.set(number, found.value);
		}

		const failures: string[] = [];
		for (const edge of missing) {
			const written = yield* addBlockedBy(
				repo,
				edge.dependent,
				ids.get(edge.prerequisite) as number,
			);
			if (written._tag === "Failure") {
				failures.push(`#${edge.dependent} → #${edge.prerequisite}: ${written.reason}`);
			}
		}

		// Every POST is proven by this re-read, failures included: a refused write and a write whose
		// response was lost look identical at the client, and only the graph can tell them apart.
		const after = yield* readGraph(repo, dependents, (what, reason) =>
			refuse(
				WRITE_UNKNOWN,
				`${VERB}: ${missing.length} edge(s) were POSTed and cannot be confirmed — cannot read ${what}: ${reason}.`,
				[...notes, scanned],
			),
		);
		if (after._tag === "Refused") return after.outcome;
		const stillMissing = missingFrom(after.edges, required);
		if (stillMissing.length > 0) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: ${stillMissing.length} edge(s) do not read back on the graph — it needs a human eye.`,
				[
					...notes,
					scanned,
					...stillMissing.map((edge) => `${VERB}: #${edge.dependent} → #${edge.prerequisite}.`),
					...failures.map((line) => `${VERB}: ${line}.`),
				],
			);
		}

		return answer(
			JSON.stringify({
				answer: "reconciled",
				epic: epic.number,
				required: required.length,
				already: required.length - missing.length,
				written: missing.length,
				verified: true,
			}),
			[...notes, scanned],
		);
	});
