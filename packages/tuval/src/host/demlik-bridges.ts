/**
 * The Demlik disposer bridge — the one Promise-and-`Dispose` seam left in the host.
 *
 * An authored program opens a Sub the way Demlik's own runner does: now, sending through a callback,
 * handing back a `Dispose`. This host runs a Sub as a Stream, so the translation lives here and
 * nowhere else, and goes with the rest of the in-tree host when Tuval runs on tea's Effect engine.
 */

import type {Dispose} from "@demlik/tea";
import {Effect, Queue, Stream} from "effect";
import type {Sub} from "../registry/sub.ts";
import type {Dispatch} from "./definition.ts";
import {SubDisposeError} from "./errors.ts";

/**
 * Disposer bridge for a Sub runner: one that opens now, sends through a callback and hands back the
 * close — Demlik's own runner shape — as the Stream runner a program row carries. Opening runs
 * under `Effect.acquireRelease` inside `Stream.callback`, whose Scope is the Stream's, so the
 * Stream's interruption awaits the `Dispose`, Promise or not, as one shutdown step.
 *
 * The Stream never ends on its own, so its lifetime is the Sub's lifetime: a runner whose Stream
 * ended would be marked `ended` and never re-armed while its id holds.
 */
export const disposerStream =
	<U extends Sub, M>(open: (sub: U, dispatch: Dispatch<M>) => Dispose) =>
	(sub: U): Stream.Stream<M> =>
		Stream.callback<M>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => open(sub, (msg) => void Queue.offerUnsafe(queue, msg))),
				(dispose) =>
					Effect.tryPromise({
						try: async () => {
							await dispose();
						},
						catch: (cause) => new SubDisposeError({cause}),
					}).pipe(Effect.orDie),
			),
		);
