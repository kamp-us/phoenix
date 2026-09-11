/**
 * `lane seats` — how many seats the lanes root is holding against `laneConcurrencyCap`, read
 * before anything is claimed.
 *
 * The read half of [`concurrency.ts`](concurrency.ts) with no boot behind it. `seatsIn` was
 * reachable only through `capRefusal`, whose callers both write, so an operator had no way to ask
 * how full the pipeline is without spending a lane claim and a boot attempt on the answer. This
 * verb closes that: it creates nothing under the root, posts no marker and makes no append, so it
 * is the one thing an operator may run before `lane claim`.
 *
 * **A full cap is an answer here, not a refusal.** `lane open` owes its caller exit `51`
 * because a boot was asked for and did not happen; this verb was asked how full the root is, and
 * "full" answers that question exactly. Refusing it would put the one state an operator runs this
 * verb to detect behind a non-zero exit, which every caller reads as UNKNOWN.
 *
 * **What cannot be read is still never zero.** An unlistable root and an unreadable
 * `laneConcurrencyCap` both refuse at {@link LANE_UNREADABLE}, on the same premise `capRefusal`
 * holds: a seat count nobody could take is UNKNOWN, and answering `free` off a failed read would
 * send an operator to claim a lane the cap has no room for.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {CONFIG_PATH} from "../config/document.ts";
import {LANE_CONCURRENCY_CAP} from "../config/keys/lane-concurrency-cap.ts";
import type {Read} from "../config/read-key.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import type {ClaimHoldReader} from "./claim-hold.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {type Seat, seatsIn} from "./concurrency.ts";
import {DISPATCH_BUDGET} from "./shell-budget.ts";

const VERB = "fabrika lane seats";

export interface SeatsOptions<R = never> {
	/** The lanes root to count — the issue-lane root a boot would land under, and nothing beside it. */
	readonly root: string;
	/** The repo's declared `laneConcurrencyCap`, read off `.fabrika.jsonc` by the adapter. */
	readonly cap: Read<number | null>;
	/** Which lanes under this root a driver is holding — only a claimed one takes a seat. */
	readonly claimed: ClaimHoldReader<R>;
	/** The instant `retryAfter` is measured from, ISO — the adapter's clock, so the verb stays pure. */
	readonly now: string;
}

/**
 * Which of the three the root is in.
 *
 * `uncapped` is its own word rather than a very large `free`: a repo that declares no cap has no
 * number to be under, and an operator reading `free` off it would believe a limit was checked.
 */
type Verdict = "full" | "free" | "uncapped";

/**
 * When a caller turned away by a full root may read again.
 *
 * A seat frees when some other lane reaches a terminal, and nothing on disk says when that will be —
 * so the honest horizon is not a prediction about those lanes but the length of the driver's own
 * loop, which is exactly what {@link DISPATCH_BUDGET} already measures. Naming one instant here
 * rather than leaving each caller to pick its own is what keeps two operators turned away by the
 * same full root from coming back at two different times.
 */
const retryAfter = (now: string): string | null => {
	const parsed = Date.parse(now);
	return Number.isNaN(parsed)
		? null
		: new Date(parsed + DISPATCH_BUDGET.minutes * 60_000).toISOString();
};

const named = (seats: ReadonlyArray<Seat>): ReadonlyArray<string> =>
	seats.map((seat) =>
		seat.held === "claimed" ? `#${seat.lane}` : `#${seat.lane} (unaccountable)`,
	);

export const runSeats = <R = never>(
	options: SeatsOptions<R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const {cap, root} = options;
		if (cap._tag === "Refused") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot read \`${LANE_CONCURRENCY_CAP}\` from ${CONFIG_PATH} (${cap.reason}) — how many lanes this repo allows is UNKNOWN, so how full ${root} is cannot be judged against it.`,
			);
		}
		const counted = yield* seatsIn(root, options.claimed);
		if (counted._tag === "Unreadable") {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot list ${root} to count the lanes standing against \`${LANE_CONCURRENCY_CAP}\` (${counted.reason}) — the seat count is UNKNOWN, never zero.`,
			);
		}
		const {seats, idle} = counted;
		const limit = cap.value;
		const claimed = seats.filter((seat) => seat.held === "claimed");
		const unaccountable = seats.filter((seat) => seat.held === "unaccountable");
		const verdict: Verdict = limit === null ? "uncapped" : seats.length >= limit ? "full" : "free";
		const retry = verdict === "full" ? retryAfter(options.now) : null;
		return answer(
			JSON.stringify(
				{
					answer: verdict,
					root,
					cap: limit,
					held: seats.length,
					// The instant to read again, on a full root only — `null` says there is nothing to wait for.
					retryAfter: retry,
					// `null` under no cap, because "how many are left" has no value where nothing bounds it.
					free: limit === null ? null : Math.max(limit - seats.length, 0),
					claimed: claimed.map((seat) => seat.lane),
					unaccountable: unaccountable.map((seat) => seat.lane),
					idle,
				},
				null,
				2,
			),
			[
				limit === null
					? `${VERB}: ${CONFIG_PATH} declares no \`${LANE_CONCURRENCY_CAP}\`, so ${root} is bounded by nothing — it holds ${seats.length} seat(s)${seats.length === 0 ? "" : `: ${named(seats).join(", ")}`}.`
					: `${VERB}: ${CONFIG_PATH} caps this repo at ${limit} lane(s) and ${root} holds ${seats.length}${seats.length === 0 ? "" : ` — ${named(seats).join(", ")}`}. ${verdict === "full" ? `No seat is free: a boot would be refused at 51${retry === null ? "" : `, so read again no sooner than ${retry}`}.` : `${limit - seats.length} seat(s) free.`}`,
				idle.length === 0
					? `${VERB}: no other lane under this root is active and unclaimed.`
					: `${VERB}: ${idle.length} further active lane(s) carry no live \`lane claim\` and are idle, so they hold nothing: ${idle.map((lane) => `#${lane}`).join(", ")}.`,
				...(unaccountable.length === 0
					? []
					: [
							`${VERB}: ${unaccountable.length} seat(s) no read can account for: ${unaccountable
								.map((seat) => `#${seat.lane}`)
								.join(
									", ",
								)} — freed by \`fabrika lane archive\`, \`fabrika lane settle\` or \`fabrika lane reconcile\`, never by a count that ignores them.`,
						]),
				`${VERB}: nothing was written — no lane directory, no claim marker, no log line.`,
			],
		);
	});
