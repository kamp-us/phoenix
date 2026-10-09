/**
 * Runs one batch: the reels machine on tea's Effect engine, its commands interpreted by the
 * studio, its state (and so its idempotency ledger) kept in a file between runs.
 */
import {createHash} from "node:crypto";
import {run} from "@demlik/tea/effect";
import {Effect, Ref} from "effect";
import {ledgerStore} from "./ledger.ts";
import {isFinished, type Outcome, reelsMachine} from "./machine.ts";
import type {Reel} from "./reel.ts";
import {Studio, StudioError} from "./studio.ts";

export const reelHash = (engine: string, reel: Reel): string =>
	createHash("sha256").update(engine).update(JSON.stringify(reel)).digest("hex").slice(0, 16);

export interface BatchOptions {
	readonly only: ReadonlyArray<string>;
	readonly force: boolean;
	readonly concurrency: number;
	readonly ledger: string;
}

/** A studio failure, as the declared error tag its command's `_err` Msg carries. */
const tagged =
	<const Tag extends string>(tag: Tag) =>
	(error: StudioError) => ({_tag: tag, message: `${error.step}: ${error.message}`});

export const runBatch = Effect.fn("Reels.runBatch")(function* (options: BatchOptions) {
	const studio = yield* Studio;
	const all = yield* studio.reels;
	const chosen =
		options.only.length === 0 ? all : all.filter((reel) => options.only.includes(reel.id));
	const unknown = options.only.filter((id) => !all.some((reel) => reel.id === id));
	const engine = yield* studio.engineHash;
	const byId = new Map(chosen.map((reel) => [reel.id, reel]));
	const serveUrl = yield* Ref.make<string | undefined>(undefined);

	const reelOf = (id: string): Effect.Effect<Reel, StudioError> => {
		const reel = byId.get(id);
		return reel === undefined
			? Effect.fail(new StudioError({step: "lookup", message: `no script for ${id}`}))
			: Effect.succeed(reel);
	};

	const handle = yield* run(reelsMachine({concurrency: options.concurrency}), {
		store: ledgerStore(options.ledger),
		onError: (error, context) =>
			process.stderr.write(`reels: runtime error in ${context.phase}: ${String(error)}\n`),
		terminal: isFinished,
		interpret: {
			soundtrack: (cmd) =>
				reelOf(cmd.reelId).pipe(
					Effect.flatMap(studio.soundtrack),
					Effect.map((path) => ({path})),
					Effect.mapError(tagged("soundtrack_failed")),
				),
			bundle: () =>
				studio.bundle.pipe(
					Effect.tap((url) => Ref.set(serveUrl, url)),
					Effect.map((url) => ({serveUrl: url})),
					Effect.mapError(tagged("bundle_failed")),
				),
			render: (cmd) =>
				Effect.gen(function* () {
					const reel = yield* reelOf(cmd.reelId);
					const url = yield* Ref.get(serveUrl);
					if (url === undefined)
						return yield* new StudioError({step: "render", message: "no bundle yet"});
					return yield* studio.render(reel, url);
				}).pipe(Effect.mapError(tagged("render_failed"))),
			pause: (cmd) => Effect.sleep(cmd.ms).pipe(Effect.as(undefined)),
			caption: (cmd) =>
				reelOf(cmd.reelId).pipe(
					Effect.flatMap((reel) => studio.caption(reel, cmd.video)),
					Effect.map((path) => ({path})),
					Effect.mapError(tagged("caption_failed")),
				),
		},
	});
	const runtime = yield* handle.ready;
	const reels = chosen.map((reel) => ({id: reel.id, hash: reelHash(engine, reel)}));
	yield* runtime.dispatch({type: "batch_requested", reels, force: options.force, at: Date.now()});
	yield* runtime.idle();
	const state = runtime.getState();
	const outcomes: Readonly<Record<string, Outcome>> = "outcomes" in state ? state.outcomes : {};
	return {state: state.type, outcomes, unknown};
});
