/**
 * `map record` — the lockstep: the answer lands under `## Decisions`, the ticket's row leaves
 * `## Frontier`, and the sub-issue closes.
 *
 * The two body edits are one PATCH and the close is second, ordered so the surviving half of a
 * partial application is the visible-and-re-runnable one — an answer recorded against a still-open
 * ticket — rather than the forbidden one, a closed ticket with no recorded answer. Re-runnable is
 * enforced, not asserted: a ticket whose answer the body already carries takes the resume branch and
 * only closes, so finishing an interrupted lockstep is the verb again — re-read the map, re-run
 * against its new digest — never a hand-close.
 *
 * <!-- anchor: RELAY-GRILLINGS-STATE-NEVER-RECOMPUTE-IT --> **A forked decision ticket's ruling is
 * read by importing the `grill` group's reader, never by re-deriving it here.** A ruling counts only
 * when four clauses hold, and those clauses are `grill read`'s to resolve; a second implementation
 * here would be a second answer to a question already enforced elsewhere, and the one that said
 * `ruled` would win by being called. So the branch calls `grill read` through `requireRuling` and
 * records only what that reader calls `ruled`: a read that did not complete is `11` and any other
 * state is `13` naming it, because UNKNOWN is never resolved to `ruled`.
 */

import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readFile} from "../io/fs.ts";
import {closeCompleted, getIssue, patchIssueBody} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {type DecisionEntry, digestOf, foldEntryText, parseBody} from "./body.ts";
import {
	BAD_SECTIONS,
	OUTCOME_UNRECORDABLE,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	TICKET_UNKNOWN,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {decisionRecorded} from "./frontier.ts";
import {
	type Citation,
	digestFresh,
	leakFree,
	notTerminal,
	requireMap,
	requireRuling,
	requireTicket,
	targetRepo,
} from "./guards.ts";
import {applyRecord, QUESTION_ID} from "./record.ts";

/** The citation an entry carries, in the one form the answer reports it. */
const citationOf = (entry: DecisionEntry): string =>
	entry.authority._tag === "Ruled"
		? `— ruled on #${entry.authority.session} ${entry.authority.questionId}`
		: `— from #${entry.authority.ticket}`;

export interface RecordOptions {
	readonly map: number;
	readonly digest: string;
	readonly ticket: number;
	readonly finding: string;
	readonly ruledOn: number | null;
	readonly spike: number | null;
	readonly questionId: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const VERB = "map record";

export const runRecord = (
	options: RecordOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		if (
			options.ruledOn !== null &&
			(options.questionId === null || !QUESTION_ID.test(options.questionId))
		) {
			return refuse(
				FAILED,
				`${VERB}: --ruled-on requires --question-id matching R<round>.<n>; got "${options.questionId ?? ""}".`,
			);
		}
		const citation: Citation | null =
			options.ruledOn !== null && options.questionId !== null
				? {session: options.ruledOn, questionId: options.questionId}
				: null;

		const read = yield* readFile(options.finding).pipe(
			Effect.map((value) => ({ok: true as const, value})),
			Effect.catchTag("fabrika-cli/ReadFailed", (cause) =>
				Effect.succeed({ok: false as const, value: cause.reason}),
			),
		);
		if (!read.ok) {
			return refuse(
				FAILED,
				`${VERB}: could not read --finding ${options.finding}: ${read.value} — the answer is UNKNOWN, never empty.`,
			);
		}
		const finding = foldEntryText(read.value);
		if (finding === "") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: --finding ${options.finding} is empty — an answer with no text is not an answer.`,
			);
		}
		const leaked = leakFree(VERB, "finding", finding);
		if (leaked !== null) return leaked;

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

		const left = notTerminal(VERB, ticket, "its answer is already on the map.");
		if (left !== null) return left;

		// The lockstep's second half, resumed. The body write lands first and the close second, so an
		// interrupted run leaves the answer recorded against a still-open ticket — the state the close
		// order deliberately chooses. Re-reading the map and re-running against its new digest finishes
		// the close instead of appending the answer a second time, which is what makes that state
		// re-runnable rather than a hand-repair (#5550). The match is the citation THIS run carries, so
		// a sibling ticket forked to the same grilling session cannot resume on the other's entry
		// (#5637). The recorded entry stands as written: a wrong answer is retracted in the open with a
		// new entry, never overwritten by a re-run (#4227).
		const recordedAlready = decisionRecorded(found.value.body, options.ticket, citation);
		if (recordedAlready !== undefined) {
			const resumeScope = `${VERB}: ${repo}, #${options.ticket}'s answer is already on #${options.map} — resuming the close.`;
			const finish = yield* closeCompleted(repo, options.ticket);
			if (finish._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: #${options.ticket}'s answer is on #${options.map} and the close did NOT land: ${finish.reason} — the ticket is still open. Re-read the map and re-run with its new digest to resume the close.`,
					[resumeScope],
				);
			}
			return answer(
				JSON.stringify({
					map: options.map,
					ticket: options.ticket,
					recorded: citationOf(recordedAlready),
					closed: true,
					resumed: true,
					digest: digestOf(found.value.body.sections),
				}),
				[resumeScope],
			);
		}

		if (ticket.state === "lane-closed" && ticket.outcome === "unreachable") {
			return refuse(
				OUTCOME_UNRECORDABLE,
				`${VERB}: #${ticket.number}'s lane returned unreachable — there is no answer to record. Re-lane it once the source is reachable, or retire it with map descope --ticket.`,
			);
		}

		let entry: DecisionEntry = {
			text: finding,
			authority: {_tag: "Finding", ticket: options.ticket},
		};
		if (ticket.state === "forked") {
			if (ticket.kind === "decision") {
				if (citation === null) {
					return refuse(
						TICKET_UNKNOWN,
						`${VERB}: #${ticket.number} is forked to #${ticket.session ?? 0} and --ruled-on was not given — a forked ticket's answer is the founder's, and it is recorded by citing his ruling, never by restating it.`,
					);
				}
				const ruling = yield* requireRuling(VERB, repo, citation, options.env);
				if (ruling._tag === "Refused") return ruling.outcome;
				entry = {
					text: finding,
					authority: {_tag: "Ruled", session: citation.session, questionId: citation.questionId},
				};
			} else {
				if (options.spike === null) {
					return refuse(
						TICKET_UNKNOWN,
						`${VERB}: #${ticket.number} is forked to spike #${ticket.spike ?? 0} and --spike was not given — the record cites the spike whose captured decision it carries.`,
					);
				}
				const spike = yield* getIssue(repo, options.spike);
				if (spike._tag === "Unknown") {
					return refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot read spike #${options.spike}: ${spike.reason} — nothing was recorded.`,
					);
				}
				if (spike._tag === "Absent" || spike.value.state !== "closed") {
					return refuse(
						TICKET_UNKNOWN,
						`${VERB}: spike #${options.spike} ${spike._tag === "Absent" ? "does not exist" : "is still open"} — a spike's captured decision is recorded once the spike is done.`,
					);
				}
			}
		} else if (citation !== null) {
			entry = {
				text: finding,
				authority: {_tag: "Ruled", session: citation.session, questionId: citation.questionId},
			};
		}

		const applied = applyRecord(found.value.body, options.ticket, entry);
		if (applied._tag === "Refused") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: #${options.map}'s body would not hold this record — ${applied.reason}; nothing was written.`,
			);
		}
		const next = applied.body;

		const scope = `${VERB}: ${repo}, #${options.ticket} resolved ${ticket.state}, ${found.value.body.decisions.length} existing decision(s).`;
		const written = yield* patchIssueBody(repo, options.map, next);
		if (written._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: could not write #${options.map}'s body: ${written.reason} — whether the answer landed is UNKNOWN and #${options.ticket} is still open.`,
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
				`${VERB}: wrote #${options.map}'s body and the read-back differs — #${options.ticket} is still open and the map needs fixing by hand.`,
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

		const closed = yield* closeCompleted(repo, options.ticket);
		if (closed._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: recorded the answer on #${options.map} and the close of #${options.ticket} did NOT land — the answer is on the map and the ticket is still open. Re-read the map and re-run with its new digest to resume the close; it will not record the answer twice.`,
				[scope],
			);
		}

		return answer(
			JSON.stringify({
				map: options.map,
				ticket: options.ticket,
				recorded: citationOf(entry),
				closed: true,
				resumed: false,
				digest: digestOf(reparsed.value.sections),
			}),
			[scope],
		);
	});
