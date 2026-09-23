/**
 * One connection's write side: a bounded queue in front of a writer that waits for each send to
 * complete. The wait is what makes the bound mean anything — `ws` buffers internally and would
 * otherwise accept frames forever, so a client that stops reading grows memory instead of being
 * closed. Over the bound the connection is closed rather than dropped from: a client that missed
 * a `session_snapshot` is out of sync, and a silently short stream is worse than a named close.
 */

import {Effect, Queue} from "effect";

export interface Outbound {
	/** Answers `false` when the frame did not fit, which is the caller's cue to close. */
	readonly offer: (frame: Uint8Array) => boolean;
	/** The writer loop. Forked by the caller; ends when the queue is shut down. */
	readonly run: Effect.Effect<void>;
	readonly pending: () => number;
}

export const makeOutbound = (options: {
	readonly capacity: number;
	readonly send: (frame: Uint8Array) => Effect.Effect<void>;
}): Effect.Effect<Outbound> =>
	Effect.map(Queue.unbounded<Uint8Array>(), (queue) => ({
		offer: (frame) => {
			if (Queue.sizeUnsafe(queue) >= options.capacity) return false;
			return Queue.offerUnsafe(queue, frame);
		},
		run: Effect.forever(Effect.flatMap(Queue.take(queue), options.send)),
		pending: () => Queue.sizeUnsafe(queue),
	}));
