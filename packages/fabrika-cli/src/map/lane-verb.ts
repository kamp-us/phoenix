/**
 * `map lane` — claim a research lane on one ticket, keyed on the run nonce, refusing a `decision`
 * ticket.
 *
 * A compare-and-set on a marker under a closed-set kind guard. Re-running with the nonce that already
 * holds the lane is `resumed`, not an error: a stateless re-dispatch of the same run must be able to
 * prove it still owns the lane without a second claim.
 *
 * The five refusals stay five seats with five remedies, which is `epic-lock`'s scar designed out: it
 * collapsed distinct refusals onto one code, so a caller could not tell an abandoned lock from a
 * missing target. Here `15`, `13`, `18` and `11` say different true things.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {createComment, getComment} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {KIND_MISMATCH, LANE_NOT_MINE, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {notTerminal, requireMapForState, requireTicket, targetRepo} from "./guards.ts";
import {composeLaneMarker, isNonce} from "./markers.ts";

export interface LaneOptions {
	readonly map: number;
	readonly ticket: number;
	readonly nonce: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const VERB = "map lane";

export const runLane = (
	options: LaneOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (!isNonce(options.nonce)) {
			return refuse(
				FAILED,
				`${VERB}: --nonce "${options.nonce}" is not eight lowercase hex characters — a human-readable label two runs would collide on is not a lane key.`,
			);
		}

		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const found = yield* requireMapForState(VERB, repo, options.map);
		if (found._tag === "Refused") return found.outcome;

		const resolved = yield* requireTicket(
			VERB,
			repo,
			options.map,
			found.value.body,
			options.ticket,
		);
		if (resolved._tag === "Refused") return resolved.outcome;
		const {ticket} = resolved.value;

		const left = notTerminal(VERB, ticket, "there is nothing left to research.");
		if (left !== null) return left;
		if (ticket.kind === "decision") {
			return refuse(
				KIND_MISMATCH,
				`${VERB}: #${ticket.number} is a decision ticket — it is the founder's to answer. Route it with map fork, never a lane.`,
			);
		}
		if (ticket.state === "lane-held") {
			return ticket.nonce === options.nonce
				? answer(
						JSON.stringify({
							map: options.map,
							ticket: options.ticket,
							nonce: options.nonce,
							lane: "resumed",
						}),
						[`${VERB}: ${repo}, #${options.ticket}'s lane already held by this nonce.`],
					)
				: refuse(
						LANE_NOT_MINE,
						`${VERB}: #${ticket.number}'s lane is held by ${ticket.nonce} — refusing to open a second lane on one ticket.`,
					);
		}

		const scope = `${VERB}: ${repo}, #${options.ticket} resolved ${ticket.state}, lane free.`;
		const body = composeLaneMarker({
			map: options.map,
			ticket: options.ticket,
			nonce: options.nonce,
		});
		const posted = yield* createComment(repo, options.ticket, body);
		if (posted._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: could not post the lane claim on #${options.ticket}: ${posted.reason} — whether the lane is held is UNKNOWN.`,
				[scope],
			);
		}
		// The POST's own response is the server echoing the request; the lane is only held once the
		// marker reads back, which is the read-back `epic-lock` never performed on its own stamp.
		const landed = yield* getComment(repo, posted.value.id);
		if (
			landed._tag === "Failure" ||
			normalizeForReadback(landed.value) !== normalizeForReadback(body)
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: posted the lane claim on #${options.ticket} and the read-back differs — the comment exists and needs a human.`,
				[scope],
			);
		}

		return answer(
			JSON.stringify({
				map: options.map,
				ticket: options.ticket,
				nonce: options.nonce,
				lane: "held",
			}),
			[scope],
		);
	});
