/**
 * The checks every `map` verb runs before it decides anything, factored here so eight verbs cannot
 * disagree about what a leak is, what a missing map is, or what a stale digest is.
 *
 * Each returns the refusal itself rather than a boolean, so a caller cannot receive "this failed" and
 * then compose a message that drifts from the code it seats.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {type QuestionRow, runRead as runGrillRead} from "../grill/read-verb.ts";
import {resolveRepo} from "../io/issues.ts";
import {isRecord, parseJson} from "../io/json.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {digestOfBody, type MapBody} from "./body.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	DIGEST_STALE,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	TICKET_RETIRED,
	TICKET_UNKNOWN,
} from "./codes.ts";
import {
	type Frontier,
	isTerminal,
	type MapRead,
	readFrontier,
	readMap,
	type Ticket,
} from "./frontier.ts";

export type Guarded<A> =
	| {readonly _tag: "Ok"; readonly value: A}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

const refused = (outcome: VerbOutcome): Guarded<never> => ({_tag: "Refused", outcome});

/** The target repository, or the usage refusal that names both ways to supply it. */
export const targetRepo = (
	verb: string,
	explicit: string | null,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Guarded<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const attempt = yield* resolveRepo(explicit, env);
		return attempt._tag === "Ok"
			? {_tag: "Ok" as const, value: attempt.value}
			: refused(
					refuse(
						FAILED,
						`${verb}: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.`,
					),
				);
	});

/**
 * Every text this group sends to GitHub is leak-scanned before the write — bodies, comments, and the
 * issue titles `map open` and `map ticket` compose (#3086: the title is scanned, not only the body).
 *
 * **The base's `5` reads "…and `--redact` was not given"; no `map` verb offers `--redact`**, so here
 * it fires on any machine-local path unconditionally. The condition narrows; the meaning does not.
 */
export const leakFree = (verb: string, what: string, text: string): VerbOutcome | null => {
	if (isBareAtReference(text)) {
		return refuse(
			BARE_AT_PATH,
			`${verb}: the ${what} is a bare "@" path reference — the text never arrived. Send the text itself.`,
		);
	}
	const scan = scanBody(text);
	return scan.leaks.length === 0
		? null
		: refuse(
				LEAKED_PATH,
				`${verb}: the ${what} carries ${scan.leaks.length} machine-local path(s) — refusing to post them to a public issue.`,
				renderLeaks(scan.leaks),
			);
};

/** The map issue and its parsed body, or the `7` / `4` / `11` refusal the read proved. */
export const requireMap = (
	verb: string,
	repo: string,
	map: number,
): Effect.Effect<
	Guarded<Extract<MapRead, {_tag: "Map"}>>,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const read = yield* readMap(repo, map);
		if (read._tag === "Map") return {_tag: "Ok" as const, value: read};
		if (read._tag === "Absent") {
			return refused(
				refuse(NO_TARGET, `${verb}: #${map} does not exist, or is not a wayfinding map.`),
			);
		}
		if (read._tag === "Malformed") {
			return refused(
				refuse(
					BAD_SECTIONS,
					`${verb}: #${map}'s body does not hold the five sections in order (${read.reason}) — refusing to act on a body this verb cannot read.`,
				),
			);
		}
		return refused(
			refuse(
				PRECONDITION_UNKNOWN,
				`${verb}: cannot read #${map}: ${read.reason} — nothing was written and the map's state is UNKNOWN.`,
			),
		);
	});

/**
 * The map, for a verb that never writes its body — `map lane` and `map finding`.
 *
 * Identical to {@link requireMap} except that an unparseable body is `11` rather than `4`. Those two
 * verbs hold no `4` seat for the map body: they do not splice it, and what an unreadable body costs
 * them is only that a ticket's `graduated` state cannot be proven — which is a precondition that
 * could not be read, not a defect in a document they were asked to write.
 */
export const requireMapForState = (
	verb: string,
	repo: string,
	map: number,
): Effect.Effect<
	Guarded<Extract<MapRead, {_tag: "Map"}>>,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const guarded = yield* requireMap(verb, repo, map);
		if (guarded._tag === "Ok" || guarded.outcome.code !== BAD_SECTIONS) return guarded;
		return refused(
			refuse(
				PRECONDITION_UNKNOWN,
				`${verb}: #${map}'s body does not parse, so whether a ticket already graduated is UNKNOWN — nothing was written.`,
			),
		);
	});

/**
 * One frontier ticket of this map, resolved against a fresh frontier read.
 *
 * A ticket that is not this map's is `13` and a frontier that could not be read is `11` — never an
 * empty frontier, which would let a rate-limited read report a real ticket as unknown.
 */
export const requireTicket = (
	verb: string,
	repo: string,
	map: number,
	body: MapBody,
	ticket: number,
): Effect.Effect<
	Guarded<{readonly ticket: Ticket; readonly frontier: Frontier}>,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const read = yield* readFrontier(repo, map, body);
		if (read._tag !== "Frontier") {
			return refused(
				refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read #${map}'s children: ${read._tag === "MapAbsent" ? "the map reports no child list" : read.reason} — nothing was written and the frontier is UNKNOWN, never empty.`,
				),
			);
		}
		const found = read.value.tickets.find((row) => row.number === ticket);
		return found === undefined
			? refused(
					refuse(TICKET_UNKNOWN, `${verb}: #${ticket} is not a frontier ticket of map #${map}.`),
				)
			: {_tag: "Ok" as const, value: {ticket: found, frontier: read.value}};
	});

/** The `18` refusal a verb owes a ticket that already left the frontier. */
export const notTerminal = (verb: string, ticket: Ticket, tail: string): VerbOutcome | null =>
	isTerminal(ticket.state)
		? refuse(TICKET_RETIRED, `${verb}: #${ticket.number} already left the frontier — ${tail}`)
		: null;

/** The ruling a forked decision ticket's record cites: a session, and one question inside it. */
export interface Citation {
	readonly session: number;
	readonly questionId: string;
}

/**
 * The reader's stdout, read as its question rows or as nothing.
 *
 * The shape is a contract between two groups, not a guarantee: a rename, an added prose line or a
 * truncated pipe all arrive here as bytes that do not parse, and a caller seats that as `11` rather
 * than reading a missing question as "not ruled".
 */
const readQuestions = (stdout: string): ReadonlyArray<QuestionRow> | undefined => {
	const parsed = parseJson(stdout);
	if (!isRecord(parsed)) return undefined;
	if (!Array.isArray(parsed.questions)) return undefined;
	return parsed.questions as ReadonlyArray<QuestionRow>;
};

/**
 * The cited question, proven `ruled` by the `grill` group's own reader.
 *
 * A read that did not complete is `11` and a question that is absent or reads any other state is
 * `13` naming the state — UNKNOWN is never resolved to `ruled`.
 */
export const requireRuling = (
	verb: string,
	repo: string,
	citation: Citation,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Guarded<QuestionRow>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const outcome = yield* runGrillRead({session: citation.session, repo, env});
		if (outcome.code !== 0) {
			const reason = outcome.stderr.at(-1) ?? "the reader refused without a reason";
			return refused(
				outcome.code === NO_TARGET
					? refuse(
							NO_TARGET,
							`${verb}: #${citation.session} does not exist, or is not a grilling session — nothing was recorded.`,
						)
					: refuse(
							PRECONDITION_UNKNOWN,
							`${verb}: cannot read #${citation.session} ${citation.questionId}: ${reason} — whether it is ruled is UNKNOWN, never assumed ruled. Nothing was recorded.`,
						),
			);
		}
		const questions = readQuestions(outcome.stdout);
		if (questions === undefined) {
			return refused(
				refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: the grilling reader exited 0 on #${citation.session} but its answer carries no questions array — whether ${citation.questionId} is ruled is UNKNOWN. Nothing was recorded.`,
				),
			);
		}
		const found = questions.find((row) => row.id === citation.questionId);
		if (found === undefined) {
			return refused(
				refuse(
					TICKET_UNKNOWN,
					`${verb}: ${citation.questionId} names no question in session #${citation.session} — nothing was recorded.`,
				),
			);
		}
		return found.state === "ruled"
			? {_tag: "Ok" as const, value: found}
			: refused(
					refuse(
						TICKET_UNKNOWN,
						`${verb}: #${citation.session} ${citation.questionId} reads "${found.state}", not "ruled" — only a ruled question's answer is the founder's, so nothing was recorded.`,
					),
				);
	});

/** The compare-and-set guard: the body must still be the one `--digest` was taken from. */
export const digestFresh = (
	verb: string,
	map: number,
	body: MapBody,
	supplied: string,
): VerbOutcome | null => {
	const current = digestOfBody(body);
	return current === supplied
		? null
		: refuse(
				DIGEST_STALE,
				`${verb}: #${map}'s body moved since --digest ${supplied} (now ${current}) — nothing was written. Re-read and re-apply.`,
			);
};
