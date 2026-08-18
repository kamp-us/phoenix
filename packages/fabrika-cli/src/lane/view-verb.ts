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
import {createServer} from "node:http";
import {type LaneFiles, laneViewer, type TransitionRequest} from "@demlik/tea/chart/lane/server";
import {Effect, type FileSystem, type Path, Result} from "effect";
import {readDir, readFile} from "../io/fs.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {LANE_UNREADABLE} from "./codes.ts";
import {runTransition} from "./transition-verb.ts";

const VERB = "fabrika lane view";

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

/**
 * One lane's two files, verbatim.
 *
 * The bytes, not the compiled machine: the page does its own importing, and handing it a value this
 * repo had already interpreted would put two readers of one document in the loop. An entry with no
 * `workflow.json` is not a lane — a scratch directory under the root is not something to draw — and
 * a lane with no `events.jsonl` is one that was emitted and never run, which is a real state and
 * shows every task where it booted.
 */
const readLane = (
	root: string,
	name: string,
): Effect.Effect<LaneFiles | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const workflow = yield* Effect.result(readFile(`${root}/${name}/workflow.json`));
		if (Result.isFailure(workflow)) return null;
		const events = yield* Effect.result(readFile(`${root}/${name}/events.jsonl`));
		return {
			id: name,
			workflow: workflow.success,
			events: Result.isFailure(events) ? "" : events.success,
			origins: ORIGINS,
		} satisfies LaneFiles;
	});

/**
 * Every lane under `root`, as the two files each one is.
 *
 * Separate from the server so the sweep is testable without binding a port, and so both the first
 * paint and every refresh go through one reader — two would eventually disagree about what counts
 * as a lane.
 */
export const laneFilesIn = (
	root: string,
): Effect.Effect<ReadonlyArray<LaneFiles>, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const names = yield* Effect.result(readDir(root));
		if (Result.isFailure(names)) return [];
		// Unbounded on purpose: this is N independent two-file reads on every refresh of a page
		// someone is watching, and serialising them would make a twelve-lane fleet feel slow for no
		// reason — no read here depends on another (.patterns/serial-read-baseline.md).
		const read = yield* Effect.forEach(names.success, (name) => readLane(root, name), {
			concurrency: "unbounded",
		});
		return read.filter((lane): lane is LaneFiles => lane !== null);
	});

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

		// Re-read on every ask rather than cache: a driver appends to these files while the screen is
		// open, and the whole point of the screen is that it is current.
		const lanes = () => run(laneFilesIn(options.root));

		const transition = (req: TransitionRequest) =>
			run(
				runTransition({
					root: options.root,
					lane: req.lane,
					event: req.event,
					task: req.task ?? null,
				}).pipe(
					Effect.map((out) => ({
						ok: out.code === 0,
						// The transition verb's own words, either way. A refusal it proved is a better
						// sentence than anything this file could compose about it.
						message: out.code === 0 ? out.stderr.join(" ") : out.stderr.join(" "),
					})),
				),
			);

		const handle = laneViewer({lanes, transition, source: options.root});

		yield* Effect.callback<void>(() => {
			const server = createServer((req, res) => {
				void (async () => {
					const body =
						req.method === "POST"
							? await new Promise<string>((ok) => {
									let read = "";
									req.on("data", (chunk) => {
										read += chunk;
									});
									req.on("end", () => ok(read));
								})
							: undefined;
					const out = await handle(
						new Request(`http://localhost:${options.port}${req.url ?? "/"}`, {
							method: req.method ?? "GET",
							...(body === undefined ? {} : {body}),
						}),
					);
					res.writeHead(out.status, Object.fromEntries(out.headers));
					if (out.body === null) {
						res.end();
						return;
					}
					// Streamed, not buffered — `/api/stream` stays open for the life of the page.
					const reader = out.body.getReader();
					for (;;) {
						const {done, value} = await reader.read();
						if (done) break;
						res.write(value);
					}
					res.end();
				})();
			});
			server.listen(options.port);
			return Effect.sync(() => {
				server.close();
			});
		});

		return answer("");
	});

/** The listening line, kept beside the verb so a test can assert the sentence a driver reads. */
export const listeningAt = (port: number): string =>
	`${VERB}: serving on http://localhost:${port} — every lane on disk, the ones needing a person first.`;
