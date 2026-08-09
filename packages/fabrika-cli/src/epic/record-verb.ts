/**
 * `epic record` — one closed-vocabulary event, appended and read back.
 *
 * The run's memory is the ledger, written only here and by `epic verdict`; nothing lives in the
 * conductor's context (H1). A dead subagent is an *expected, recordable* outcome — `dispatch-dead` —
 * not an anomaly that crashes the run.
 *
 * **The SHA is self-captured, never taken from the caller.** A caller-supplied SHA on
 * `slice-dispatched` / `slice-landed` would reopen the very self-report hole this group closes, so
 * the tree is asked at append time and the answer omits the capture — the tail read-back re-reads
 * the line that carries it, which proves it from the artifact instead of echoing it.
 */
import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {headSha} from "../build/git.ts";
import {badNumber} from "../build/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {appendLine} from "./append.ts";
import {
	BREAKER_TRIPPED,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {breakerFor} from "./fold.ts";
import {
	EPIC_EVENTS,
	type EpicEvent,
	forSlice,
	isEpicEvent,
	nextSeq,
	SHA_CAPTURING,
	SLICE_SCOPED,
} from "./ledger.ts";
import {laneGround, loadRun} from "./run.ts";

const VERB = "epic record";

export interface RecordOptions {
	readonly number: number;
	readonly event: string;
	readonly slice: string | null;
	readonly detail: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly at: string;
}

/** The events a slice may still take once its breaker is at cap. */
const PAST_BREAKER: ReadonlyArray<EpicEvent> = ["breaker-tripped", "run-halted"];

export const runRecord = (
	options: RecordOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const epic = options.number;
		const bad = badNumber(VERB, "an issue number", epic);
		if (bad !== null) return bad;

		if (options.event === "verdict-recorded") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: verdict-recorded is written only by "fabrika epic verdict" — use it.`,
			);
		}
		if (!isEpicEvent(options.event)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --event "${options.event}" is not in the event vocabulary.`,
				[`${VERB}: the vocabulary is ${EPIC_EVENTS.join(", ")}.`],
			);
		}
		const event = options.event;

		const ground = yield* laneGround(VERB, epic, null, options.env);
		if (ground._tag === "Refused") return ground.outcome;

		const run = yield* loadRun(VERB, epic, ground);
		if (run._tag === "Refused") return run.outcome;

		const sliceScoped = SLICE_SCOPED.includes(event);
		const slice = options.slice;
		if (sliceScoped && slice === null) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --event ${event} names a slice — pass --slice.`,
				ground.notes,
			);
		}
		if (slice !== null && !run.plan.slices.some((row) => row.id === slice)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: slice "${slice}" is not in run ${run.plan.run}.`,
				ground.notes,
			);
		}

		if (slice !== null && !PAST_BREAKER.includes(event)) {
			const axis = breakerFor(run.lines, slice);
			if (axis !== null) {
				return refuse(
					BREAKER_TRIPPED,
					`${VERB}: slice "${slice}"'s ${axis} breaker is at cap — record breaker-tripped or run-halted, nothing else.`,
					ground.notes,
				);
			}
		}

		if (
			event === "slice-landed" &&
			slice !== null &&
			!forSlice(run.lines, slice).some((line) => line.event === "slice-dispatched")
		) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: slice "${slice}" has no slice-dispatched on record — a landing contradicts the run's state.`,
				ground.notes,
			);
		}

		let sha: string | null = null;
		if (SHA_CAPTURING.includes(event)) {
			const head = yield* headSha;
			if (head._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read HEAD: ${head.reason} — nothing was recorded.`,
					ground.notes,
				);
			}
			sha = head.value;
		}

		const seq = nextSeq(run.lines);
		const appended = yield* appendLine(ground.dir, {
			seq,
			at: options.at,
			event,
			slice,
			detail: options.detail,
			sha,
		});
		if (appended._tag === "Unknown") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the append could not be proven (${appended.reason}) — the ledger state is UNKNOWN.`,
				ground.notes,
			);
		}
		if (appended._tag === "Mismatch") {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the append landed but the tail does not read back — the ledger needs a human eye.`,
				ground.notes,
			);
		}
		return answer(JSON.stringify({answer: "recorded", seq, event, slice}), ground.notes);
	});
