/**
 * `map ticket` — file a frontier ticket, link it as a sub-issue, set its blocking edges, and splice
 * its line onto the map, as one act.
 *
 * **Preconditions resolve before anything is written.** Every `--blocks` and `--blocked-by` target is
 * existence-checked, confirmed to be a ticket of this map, and resolved to its internal id, and the
 * cycle check runs — all before the create. That ordering is what makes `13`, `14`, `18` and `19`
 * honestly mean *nothing was written*: an id that cannot be resolved is discovered while the frontier
 * is still untouched, rather than after a ticket exists.
 *
 * **Write order, and what each partial application leaves.** Create the ticket, post its marker
 * comment, link it as a sub-issue, set the edges, then splice the map body — in that order, with the
 * body guard re-checked immediately before the splice. A failure after the create leaves an issue
 * with no marker, which `map read` does not count as a ticket of this map, so it is inert rather than
 * half-present and a re-run resumes it. The splice is last because it is the only write that can be
 * lost to a concurrent writer, so it spends the shortest possible time between the guard and the
 * write.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {addBlockedBy, addSubIssue, internalId} from "../io/edges.ts";
import {createComment, createUnlabelledIssue, getIssue, patchIssueBody} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	digestOf,
	isKind,
	KINDS,
	parseBody,
	renderFrontierRow,
	spliceSection,
} from "./body.ts";
import {
	ALREADY_DESCOPED,
	EDGE_UNRESOLVABLE,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	TICKET_RETIRED,
	TICKET_UNKNOWN,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {isTerminal, readFrontier, type Ticket} from "./frontier.ts";
import {digestFresh, leakFree, requireMap, targetRepo} from "./guards.ts";
import {composeTicketMarker, isNonce} from "./markers.ts";
import {namesSameThing} from "./open.ts";
import {cycleFrom, ticketBody, ticketTitle, waitsOnGraph} from "./ticket.ts";

export interface TicketOptions {
	readonly map: number;
	readonly digest: string;
	/** Validated here rather than at the parser, so an off-vocabulary kind is `1` with a named set. */
	readonly kind: string;
	readonly question: string;
	readonly blocks: ReadonlyArray<number>;
	readonly blockedBy: ReadonlyArray<number>;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/**
	 * This run's nonce, stamped into the ticket's marker.
	 *
	 * Injected rather than read from the environment, and injected rather than flagged: the contract's
	 * input table for this verb declares no `--nonce`, so adding one would be a surface it does not
	 * specify — see the spec-defect note on #5022. The production caller supplies four random bytes.
	 */
	readonly nonce: () => string;
}

const VERB = "map ticket";

export const runTicket = (
	options: TicketOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const question = options.question.trim();
		if (question === "") {
			return refuse(FAILED, `${VERB}: --question is empty — refusing to file a ticket asking nothing.`);
		}
		const kind = options.kind.trim();
		if (!isKind(kind)) {
			return refuse(
				FAILED,
				`${VERB}: --kind "${kind}" is not one of ${KINDS.join(", ")}.`,
			);
		}
		const nonce = options.nonce();
		if (!isNonce(nonce)) {
			return refuse(FAILED, `${VERB}: "${nonce}" is not an eight-hex-character run nonce.`);
		}

		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const leaked = leakFree(VERB, "question", question);
		if (leaked !== null) return leaked;

		const found = yield* requireMap(VERB, repo, options.map);
		if (found._tag === "Refused") return found.outcome;
		const stale = digestFresh(VERB, options.map, found.value.body, options.digest);
		if (stale !== null) return stale;

		const rejected = found.value.body.outOfScope.find((entry) =>
			namesSameThing(question, entry.direction),
		);
		if (rejected !== undefined) {
			return refuse(
				ALREADY_DESCOPED,
				`${VERB}: "${question}" restates a direction recorded out of scope on #${options.map} (${rejected.recordedAt}) — nothing was written. Read the recorded reasoning before charting it.`,
			);
		}

		const frontier = yield* readFrontier(repo, options.map, found.value.body);
		if (frontier._tag !== "Frontier") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${options.map}'s children: ${frontier._tag === "MapAbsent" ? "the map reports no child list" : frontier.reason} — nothing was written.`,
			);
		}
		const tickets = frontier.value.tickets;
		const byNumber = new Map<number, Ticket>(tickets.map((ticket) => [ticket.number, ticket]));

		for (const [flag, targets] of [
			["--blocked-by", options.blockedBy],
			["--blocks", options.blocks],
		] as const) {
			for (const number of targets) {
				const ticket = byNumber.get(number);
				if (ticket === undefined) {
					return refuse(
						TICKET_UNKNOWN,
						`${VERB}: ${flag} ${number} is not a frontier ticket of map #${options.map}.`,
					);
				}
				if (isTerminal(ticket.state)) {
					return refuse(
						TICKET_RETIRED,
						`${VERB}: ${flag} ${number} already left the frontier — a cleared question cannot gate an open one.`,
					);
				}
			}
		}

		const cycle = cycleFrom(waitsOnGraph(tickets), options.blockedBy, options.blocks);
		if (cycle !== null) {
			return refuse(
				EDGE_UNRESOLVABLE,
				`${VERB}: --blocks ${cycle.gates} would close a cycle (${cycle.gates} -> this ticket -> ${cycle.waitsOn} -> ${cycle.gates}) — refusing to make a frontier no run can drain.`,
			);
		}

		// Resolved before the create so an unresolvable id refuses while the frontier is untouched.
		const ids = new Map<number, number>();
		for (const number of [...options.blockedBy, ...options.blocks]) {
			if (ids.has(number)) continue;
			const id = yield* internalId(repo, number);
			if (id._tag !== "Present") {
				return refuse(
					EDGE_UNRESOLVABLE,
					`${VERB}: cannot resolve ${number}'s internal id: ${id._tag === "Absent" ? "no such issue" : id.reason} — an edge POST takes the id, never the number. Resolved before the create, so nothing was written.`,
				);
			}
			ids.set(number, id.value);
		}

		const scope = `${VERB}: ${repo}, ${tickets.length} existing ticket(s), ${options.blockedBy.length + options.blocks.length} edge target(s) resolved.`;

		const created = yield* createUnlabelledIssue(
			repo,
			ticketTitle(question),
			ticketBody(question, options.map),
		);
		if (created._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: could not file the ticket in ${repo}: ${created.reason} — whether it landed is UNKNOWN.`,
				[scope],
			);
		}
		const child = created.value.number;

		const marker = yield* createComment(
			repo,
			child,
			composeTicketMarker({map: options.map, kind, nonce}),
		);
		if (marker._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: filed #${child} and its marker comment did NOT land — the issue exists and is not a frontier ticket of #${options.map}. Re-run with the same question to resume.`,
				[scope],
			);
		}

		const childId = yield* internalId(repo, child);
		if (childId._tag !== "Present") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: filed #${child} and its internal id could not be resolved — the ticket exists and is not on the map. Link it before charting on.`,
				[scope],
			);
		}
		const linked = yield* addSubIssue(repo, options.map, childId.value);
		if (linked._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: filed #${child} and the sub-issue LINK to #${options.map} did NOT land — the ticket exists and is not on the map. Link it before charting on.`,
				[scope],
			);
		}

		for (const number of options.blockedBy) {
			const edge = yield* addBlockedBy(repo, child, ids.get(number) as number);
			if (edge._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: linked #${child} and its --blocked-by ${number} edge did NOT land — the ticket is on the map with an incomplete topology.`,
					[scope],
				);
			}
		}
		for (const number of options.blocks) {
			const edge = yield* addBlockedBy(repo, number, childId.value);
			if (edge._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: linked #${child} and its --blocks ${number} edge did NOT land — the ticket is on the map with an incomplete topology.`,
					[scope],
				);
			}
		}

		// Re-read and re-check the guard immediately before the splice: the reads above take time, and
		// the body is the one surface a concurrent lane also writes.
		const reread = yield* requireMap(VERB, repo, options.map);
		if (reread._tag === "Refused") return reread.outcome;
		const guard = digestFresh(VERB, options.map, reread.value.body, options.digest);
		if (guard !== null) return guard;

		const rows = [
			...reread.value.body.frontier.map(renderFrontierRow),
			renderFrontierRow({ticket: child, kind, question, forkedTo: null}),
		].join("\n");
		const next = spliceSection(reread.value.body, "Frontier", rows);
		const written = yield* patchIssueBody(repo, options.map, next);
		if (written._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: filed and linked #${child} and the map body write did NOT land: ${written.reason} — the ticket is on the map and its row is not.`,
				[scope],
			);
		}

		const landed = yield* getIssue(repo, options.map);
		if (landed._tag !== "Present" || normalizeForReadback(landed.value.body) !== normalizeForReadback(next)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote #${options.map}'s body and the read-back differs — the ticket #${child} exists and the map needs fixing by hand.`,
				[scope],
			);
		}
		const reparsed = parseBody(landed.value.body);
		if (reparsed._tag === "Malformed") {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote #${options.map}'s body and it no longer parses (${reparsed.reason}) — the ticket #${child} exists and the map needs fixing by hand.`,
				[scope],
			);
		}

		return answer(
			JSON.stringify({
				map: options.map,
				ticket: child,
				kind,
				blockedBy: options.blockedBy,
				blocking: options.blocks,
				digest: digestOf(reparsed.value.sections),
			}),
			[scope],
		);
	});
