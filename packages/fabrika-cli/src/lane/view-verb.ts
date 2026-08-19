/**
 * `lane view` — every lane on disk, on one screen, sorted by what needs a person.
 *
 * `lane status` answers one lane and `lane stale` answers liveness across the fleet; neither
 * answers the question a driver actually opens a terminal to ask, which is WHICH OF THESE NEEDS ME.
 * A driver reading twelve `stateValue` blocks to find the one task a human has to unblock is doing
 * by hand what the fold already knows (#6131).
 *
 * **The page is not ours and neither is the derivation.** `@demlik/tea/chart/lane/server` ships the
 * screen prebuilt — the attention ordering, what is stuck and why, each region drawn with the path
 * it walked, the scrubber over the history — and asks for the facts only this repo can know. This
 * verb supplies two of them:
 *
 *   WHERE THE LANES ARE — the same sweep `lane stale` does, over the same roots.
 *   HOW AN EVENT IS RECORDED — {@link runTransition}, unchanged and still the only writer.
 *
 * That second one is the whole reason this is safe to add. The page never touches `events.jsonl`:
 * it asks this verb, which asks `lane transition`, which validates against the folded state FIRST
 * and appends only an event the machine accepts. A refusal comes back as the transition verb's own
 * words and is displayed verbatim. There is no second writer and no second set of rules — the
 * screen cannot drift from the ledger because it cannot write to it.
 *
 * It serves on localhost and reads the disk it is started on. Nothing is uploaded and no lane
 * leaves the machine.
 */
import {serveLaneViewer, type TransitionRequest} from "@demlik/tea/chart/lane/server";
import {Effect, type FileSystem, type Path, Result, Schema} from "effect";
import {readDir} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {runTransition} from "./transition-verb.ts";

const VERB = "fabrika lane view";

/** The one way serving fails: something else already holds the port. */
class ServeFailed extends Schema.TaggedErrorClass<ServeFailed>("ServeFailed")("ServeFailed", {
	port: Schema.Number,
	reason: Schema.String,
}) {}

export const DEFAULT_VIEW_PORT = 5411;

/**
 * WHO SENDS WHAT — the one fact `workflow.json` does not record.
 *
 * A document records topology and never provenance, so without this the screen can see that a task
 * cannot move and not that it is WAITING ON SOMEONE. Keyed by the bare event name: `ISSUE.WIP` and
 * `PARK_SWEEP.WIP` are the same `WIP`, and the namespace is presentation.
 *
 * `UNBLOCKED` is a human and only a human — that is what parking is FOR. `DONE`/`PASS`/`FAIL` are
 * the work the lane dispatched answering back, which is a Cmd's result in every sense tea means it:
 * fabrika spawns a shell on entering a working state and the shell reports its terminal token.
 */
const ORIGINS = {
	from: {
		WIP: {world: "the operator"},
		BLOCKED: {world: "the operator"},
		UNBLOCKED: {world: "a human"},
		DONE: "cmd",
		PASS: "cmd",
		FAIL: "cmd",
	},
} as const;

export interface ViewOptions {
	/** The lanes root to serve. */
	readonly root: string;
	/** The port to listen on. */
	readonly port: number;
}

export const runView = (
	options: ViewOptions,
): Effect.Effect<VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const listing = yield* Effect.result(readDir(options.root));
		if (Result.isFailure(listing)) {
			// A root that is there and cannot be listed leaves the lane set UNKNOWN. Serving a short
			// list would say "these are your lanes" about an answer that is missing some.
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: cannot list ${options.root}: ${listing.failure.reason} — the lane set is UNKNOWN, never a short list.`,
			);
		}

		// The HTTP callbacks are plain promises, so the verb's services have to cross into them.
		// Effect v4 has no `Runtime`: grab the context once and run each callback with it.
		const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
		const run = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>) =>
			Effect.runPromiseWith(services)(effect);

		const transition = (req: TransitionRequest) =>
			run(
				runTransition({
					root: options.root,
					lane: req.lane,
					event: req.event,
					task: req.task ?? null,
				}).pipe(
					// The transition verb's own words, either way — a refusal it proved is a better
					// sentence than anything this file could compose about it, and its answer line
					// already names what it appended.
					Effect.map((out) => ({ok: out.code === 0, message: out.stderr.join(" ")})),
				),
			);

		// A port already in use is the one way this fails, and it is a failure to RUN rather than a
		// verdict the verb proved — so it is seated at 1 with the port named, not in the 3+ band.
		const started = yield* Effect.result(
			Effect.tryPromise({
				try: () =>
					serveLaneViewer({
						root: options.root,
						origins: ORIGINS,
						transition,
						port: options.port,
					}),
				catch: (cause) => new ServeFailed({port: options.port, reason: String(cause)}),
			}),
		);
		if (Result.isFailure(started)) {
			return refuse(
				FAILED,
				`${VERB}: cannot serve on port ${options.port}: ${started.failure.reason} — pass --port to choose another.`,
			);
		}
		const server = started.success;

		// Serve until interrupted. The verb owns nothing about HTTP — the package creates the
		// server, bridges the request and streams the response; this file supplies the two facts
		// only fabrika knows.
		yield* Effect.callback<void>(() =>
			Effect.tryPromise({
				try: () => server.close(),
				catch: (cause) => new ServeFailed({port: options.port, reason: String(cause)}),
			}).pipe(Effect.orDie),
		);

		return answer("");
	});

/** The listening line, kept beside the verb so a test can assert the sentence a driver reads. */
export const listeningAt = (port: number): string =>
	`${VERB}: serving on http://localhost:${port} — every lane on disk, the ones needing a person first.`;
