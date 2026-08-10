/**
 * `map fork` — record that a ticket's question is being answered elsewhere.
 *
 * <!-- anchor: TWO-ROUTES-ONE-SHAPE --> A `decision` is answered in conversation and belongs to
 * `grilling`; an **empirical** question — one only running throwaway code can settle — belongs to
 * `prototyping`. This verb records *where* either is being answered and nothing about the answer. It
 * is an invocation seam only: this group runs no spike and no verb in it writes code.
 *
 * <!-- anchor: RELAY-THE-RULING-NEVER-ASSERT-ONE --> **It records where the decision is being made;
 * it never records the decision.** A ruling reaches `## Decisions` only through `map record` citing a
 * `grilling` question id. Nothing here writes an authority claim and no flag accepts one — v1's whole
 * given-grounding law reduced to an agent typing `(@founder)` after an entry that nothing verified.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment, getIssue, patchIssueBody} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {digestOf, parseBody, renderFrontierRow, spliceSection} from "./body.ts";
import {
	KIND_MISMATCH,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	TICKET_UNKNOWN,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {digestFresh, notTerminal, requireMap, requireTicket, targetRepo} from "./guards.ts";
import {composeForkMarker} from "./markers.ts";

/** The label a `grilling` session issue carries. A plain label read, never a second reader. */
export const SESSION_LABEL = "grilling:session";

export interface ForkOptions {
	readonly map: number;
	readonly digest: string;
	readonly ticket: number;
	readonly session: number | null;
	readonly spike: number | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const VERB = "map fork";

export const runFork = (
	options: ForkOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const found = yield* requireMap(VERB, repo, options.map);
		if (found._tag === "Refused") return found.outcome;
		const stale = digestFresh(VERB, options.map, found.value.body, options.digest);
		if (stale !== null) return stale;

		const resolved = yield* requireTicket(
			VERB,
			repo,
			options.map,
			found.value.body,
			options.ticket,
		);
		if (resolved._tag === "Refused") return resolved.outcome;
		const {ticket} = resolved.value;

		const left = notTerminal(VERB, ticket, "a cleared question is not routed anywhere.");
		if (left !== null) return left;

		// Which flag is admitted is decided by the ticket's kind, not by the caller: `decision` takes
		// `--session`, `prototype` takes `--spike`, and `research` takes neither — it is laned.
		const wanted =
			ticket.kind === "decision" ? "session" : ticket.kind === "prototype" ? "spike" : null;
		const given =
			options.session !== null && options.spike !== null
				? "both"
				: options.session !== null
					? "session"
					: options.spike !== null
						? "spike"
						: "neither";
		if (wanted === null) {
			return refuse(
				KIND_MISMATCH,
				`${VERB}: #${ticket.number} is kind ${ticket.kind}, which is answered in a lane rather than routed — re-file it as a decision ticket or resolve it in a lane.`,
			);
		}
		if (given !== wanted) {
			return refuse(
				KIND_MISMATCH,
				`${VERB}: #${ticket.number} is kind ${ticket.kind}, which takes --${wanted}; ${given === "both" ? "both were given" : given === "neither" ? "neither was given" : `--${given} was given`}.`,
			);
		}
		const route = wanted;
		const routed = (route === "session" ? options.session : options.spike) as number;

		const elsewhere = yield* getIssue(repo, routed);
		if (elsewhere._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read #${routed}: ${elsewhere.reason} — nothing was written and where the question is being answered is UNKNOWN.`,
			);
		}
		if (elsewhere._tag === "Absent") {
			return refuse(
				TICKET_UNKNOWN,
				`${VERB}: #${routed} does not exist — refusing to point a fork at an issue no run will read.`,
			);
		}
		if (route === "session" && !elsewhere.value.labels.includes(SESSION_LABEL)) {
			return refuse(
				TICKET_UNKNOWN,
				`${VERB}: #${routed} is not a grilling session — refusing to point a fork at an issue no grilling run will read.`,
			);
		}

		const scope = `${VERB}: ${repo}, #${options.ticket} kind ${ticket.kind}, routed to #${routed}.`;
		const markerBody = composeForkMarker({
			map: options.map,
			ticket: options.ticket,
			route,
			issue: routed,
		});
		const posted = yield* createComment(repo, options.ticket, markerBody);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: could not record the fork on #${options.ticket}: ${posted.reason} — whether it is routed is UNKNOWN.`,
				[scope],
			);
		}
		const landedMarker = yield* getComment(repo, posted.value.id);
		if (
			landedMarker._tag === "Failure" ||
			normalizeForReadback(landedMarker.value) !== normalizeForReadback(markerBody)
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: recorded the fork on #${options.ticket} and the read-back differs — the comment exists and needs a human.`,
				[scope],
			);
		}

		const reread = yield* requireMap(VERB, repo, options.map);
		if (reread._tag === "Refused") return reread.outcome;
		const guard = digestFresh(VERB, options.map, reread.value.body, options.digest);
		if (guard !== null) return guard;

		const rows = reread.value.body.frontier
			.map((row) =>
				renderFrontierRow(row.ticket === options.ticket ? {...row, forkedTo: routed} : row),
			)
			.join("\n");
		const next = spliceSection(reread.value.body, "Frontier", rows);
		const written = yield* patchIssueBody(repo, options.map, next);
		if (written._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: recorded the fork on #${options.ticket} and the map body write did NOT land: ${written.reason} — the ticket is routed and the map does not say so.`,
				[scope],
			);
		}

		const landed = yield* getIssue(repo, options.map);
		if (
			landed._tag !== "Present" ||
			normalizeForReadback(landed.value.body) !== normalizeForReadback(next)
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote #${options.map}'s body and the read-back differs — the map needs fixing by hand.`,
				[scope],
			);
		}
		const reparsed = parseBody(landed.value.body);
		if (reparsed._tag === "Malformed") {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote #${options.map}'s body and it no longer parses (${reparsed.reason}) — the map needs fixing by hand.`,
				[scope],
			);
		}

		return answer(
			JSON.stringify({
				map: options.map,
				ticket: options.ticket,
				...(route === "session" ? {session: routed} : {spike: routed}),
				state: "forked",
				digest: digestOf(reparsed.value.sections),
			}),
			[scope],
		);
	});
