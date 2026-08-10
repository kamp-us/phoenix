/**
 * `map finding` — close a lane with an outcome from a closed set.
 *
 * <!-- anchor: NOTHING-IS-NOT-EMPTY --> **The outcome vocabulary keeps three answers apart that an
 * absence would collapse into one.** `answered` means the lane established the fact and the finding
 * carries it. `no-evidence` means the lane looked and the evidence is not there — a **result**, and
 * the finding, when given, records where it looked. `unreachable` means the lane could not look at
 * all. A verb that accepted a silent empty finding would let all three arrive as one, which is
 * exactly how a zero-files-read classifier ships a plausible answer (#4060). There is no fourth value
 * and no default.
 *
 * This verb writes on the **ticket** and never touches the map body — that is `map record`,
 * deliberately separate, so the lane traffic of a parallel burndown never contends on the one body
 * every lane shares (#3709).
 */

import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readFile} from "../io/fs.ts";
import {createComment, getComment} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	BAD_SECTIONS,
	KIND_MISMATCH,
	LANE_NOT_MINE,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {leakFree, notTerminal, requireMapForState, requireTicket, targetRepo} from "./guards.ts";
import {composeFindingMarker, isNonce, isOutcome, OUTCOMES} from "./markers.ts";

export interface FindingOptions {
	readonly map: number;
	readonly ticket: number;
	readonly nonce: string;
	/** Validated here rather than at the parser, so an off-vocabulary outcome is `1` with a named set. */
	readonly outcome: string;
	readonly finding: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const VERB = "map finding";

export const runFinding = (
	options: FindingOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		if (!isNonce(options.nonce)) {
			return refuse(
				FAILED,
				`${VERB}: --nonce "${options.nonce}" is not eight lowercase hex characters.`,
			);
		}
		const outcome = options.outcome.trim();
		if (!isOutcome(outcome)) {
			return refuse(FAILED, `${VERB}: --outcome "${outcome}" is not one of ${OUTCOMES.join(", ")}.`);
		}
		if (outcome === "answered" && options.finding === null) {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: --outcome answered requires --finding — an answered lane with no finding is indistinguishable from one that found nothing.`,
			);
		}

		let text = "";
		if (options.finding !== null) {
			const read = yield* readFile(options.finding).pipe(
				Effect.map((value) => ({ok: true as const, value})),
				Effect.catchTag("fabrika-cli/ReadFailed", (cause) =>
					Effect.succeed({ok: false as const, value: cause.reason}),
				),
			);
			if (!read.ok) {
				return refuse(
					FAILED,
					`${VERB}: could not read --finding ${options.finding}: ${read.value} — the finding is UNKNOWN, never empty.`,
				);
			}
			if (read.value.trim() === "") {
				return refuse(
					BAD_SECTIONS,
					`${VERB}: --finding ${options.finding} is empty — an empty finding is not an answer; use --outcome no-evidence.`,
				);
			}
			text = read.value;
			const leaked = leakFree(VERB, "finding", text);
			if (leaked !== null) return leaked;
		}

		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const found = yield* requireMapForState(VERB, repo, options.map);
		if (found._tag === "Refused") return found.outcome;

		const resolved = yield* requireTicket(VERB, repo, options.map, found.value.body, options.ticket);
		if (resolved._tag === "Refused") return resolved.outcome;
		const {ticket} = resolved.value;

		const left = notTerminal(VERB, ticket, "there is no lane left to close.");
		if (left !== null) return left;
		if (ticket.kind === "decision") {
			return refuse(
				KIND_MISMATCH,
				`${VERB}: #${ticket.number} is a decision ticket — a decision has no lane.`,
			);
		}
		if (ticket.state !== "lane-held" || ticket.nonce !== options.nonce) {
			return refuse(
				LANE_NOT_MINE,
				`${VERB}: ${options.nonce} does not hold #${ticket.number}'s lane (${ticket.state === "lane-held" ? `held by ${ticket.nonce}` : `the ticket reads ${ticket.state}`}) — nothing was recorded.`,
			);
		}

		const scope = `${VERB}: ${repo}, #${options.ticket}'s lane held by ${options.nonce}, ${new TextEncoder().encode(text).length} finding byte(s).`;
		const marker = composeFindingMarker({
			map: options.map,
			ticket: options.ticket,
			outcome,
			nonce: options.nonce,
		});
		const body = text === "" ? `${marker}\n` : `${marker}\n\n${text}`;
		const posted = yield* createComment(repo, options.ticket, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: could not record the finding on #${options.ticket}: ${posted.reason} — whether the lane is released is UNKNOWN.`,
				[scope],
			);
		}
		const landed = yield* getComment(repo, posted.value.id);
		if (
			landed._tag === "Failure" ||
			normalizeForReadback(landed.value) !== normalizeForReadback(body)
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: recorded the finding on #${options.ticket} and the read-back differs — the comment exists and needs a human.`,
				[scope],
			);
		}

		return answer(
			JSON.stringify({
				map: options.map,
				ticket: options.ticket,
				outcome,
				comment: posted.value.id,
				lane: "released",
			}),
			[scope],
		);
	});
