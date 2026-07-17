/**
 * standup/ensure-tracker — the launcher's ensure-tracker-running step: guarantee the per-project
 * tracker is up as a standing process before any crew session is stood up.
 *
 * The one non-obvious thing is first-peer-spawn (see `../tracker/server.ts`): a successful bind on
 * the per-project socket means WE started the tracker; an `EADDRINUSE` means one is already serving
 * this project and we reuse it. `tryBecomeTracker` classifies that bind outcome (the unit-tested
 * core); `ensureTrackerRunning` detaches the tracker into its own OS process so it outlives the
 * launcher and every session the launcher spawns — the open-peer-surface reason a non-Claude peer
 * can announce when no crew session is up. This module wraps `../tracker/`'s primitives read-only;
 * it never edits the registry/protocol.
 */
import {spawn} from "node:child_process";
import {connect} from "node:net";
import {fileURLToPath} from "node:url";
import {NodeRuntime} from "@effect/platform-node";
import {Effect, Layer, type Scope} from "effect";
import * as Schema from "effect/Schema";
import type {SocketServerError} from "effect/unstable/socket/SocketServer";
import {socketPathFor, trackerServerLayer} from "../tracker/index.ts";

/** Which side of the first-peer-spawn race a stand-up landed on. */
export type TrackerBindOutcome = "started" | "already-serving";

/** The launcher couldn't confirm the per-project socket was serving within the wait budget. */
export class TrackerNotServingError extends Schema.TaggedErrorClass<TrackerNotServingError>()(
	"@kampus/pipeline-crew-mcp/standup/TrackerNotServingError",
	{socketPath: Schema.String},
) {}

/** A detached standing tracker: the child's pid and the socket every peer of the project dials. */
export interface TrackerHandle {
	readonly pid: number | undefined;
	readonly socketPath: string;
}

/** EADDRINUSE is the first-peer-spawn signal that a tracker already serves this socket. */
const isAddressInUse = (error: SocketServerError): boolean => {
	const cause = error.reason.cause;
	return (
		typeof cause === "object" &&
		cause !== null &&
		"code" in cause &&
		(cause as {readonly code?: unknown}).code === "EADDRINUSE"
	);
};

/**
 * Attempt to become the tracker on `socketPath` within the ambient scope: a won bind is `"started"`
 * and the server is live for the scope's lifetime; an `EADDRINUSE` is `"already-serving"` (reuse, no
 * double-bind). Any other bind failure crosses the error channel. This is the bind-outcome core the
 * standing-process wrapper and the tests both drive.
 */
export const tryBecomeTracker = (
	socketPath: string,
): Effect.Effect<TrackerBindOutcome, SocketServerError, Scope.Scope> =>
	Layer.build(trackerServerLayer(socketPath)).pipe(
		Effect.map((): TrackerBindOutcome => "started"),
		Effect.catchTag("SocketServerError", (error) =>
			isAddressInUse(error)
				? Effect.succeed<TrackerBindOutcome>("already-serving")
				: Effect.fail(error),
		),
	);

/**
 * The standing-tracker entry the detached child runs: win the bind and block so the server stays up
 * (`Effect.never` holds the scope open), or return promptly when a tracker already serves. This is
 * the reuse-tolerant sibling of `../tracker/server.ts`'s raw `launchTracker` — it exits cleanly on
 * `EADDRINUSE` instead of surfacing it as a failure.
 */
export const runStandingTracker = (
	projectRoot: string,
): Effect.Effect<TrackerBindOutcome, SocketServerError> =>
	Effect.scoped(
		tryBecomeTracker(socketPathFor(projectRoot)).pipe(
			Effect.tap((outcome) => (outcome === "started" ? Effect.never : Effect.void)),
		),
	);

/** Non-destructively probe whether something is serving `socketPath` (a client connect, then hang up). */
const probeSocketServing = (socketPath: string): Effect.Effect<boolean> =>
	Effect.callback<boolean>((resume) => {
		const sock = connect(socketPath);
		const settle = (serving: boolean) => {
			sock.removeAllListeners();
			sock.destroy();
			resume(Effect.succeed(serving));
		};
		sock.once("connect", () => settle(true));
		sock.once("error", () => settle(false));
	});

/** Poll until the socket is serving, or fail once the attempt budget is spent (~5s at 100ms spacing). */
const awaitSocketServing = (
	socketPath: string,
	attemptsLeft: number,
): Effect.Effect<void, TrackerNotServingError> =>
	probeSocketServing(socketPath).pipe(
		Effect.flatMap((serving) =>
			serving
				? Effect.void
				: attemptsLeft <= 0
					? Effect.fail(new TrackerNotServingError({socketPath}))
					: Effect.sleep("100 millis").pipe(
							Effect.andThen(awaitSocketServing(socketPath, attemptsLeft - 1)),
						),
		),
	);

/** Absolute path to this module — the entry the detached standing-tracker child re-enters at. */
const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * Ensure a standing tracker for `projectRoot` before stand-up. Spawns the standing tracker as a
 * detached child (`detached` + `unref` + ignored stdio) so it outlives this launcher process and
 * every session it spawns, then waits until the per-project socket is confirmed serving — whether by
 * the child we just spawned (start-if-absent) or one that was already up (reuse-if-present, the child
 * exits on `EADDRINUSE`). Returns the child pid and the socket path peers dial.
 */
export const ensureTrackerRunning = (
	projectRoot: string,
): Effect.Effect<TrackerHandle, TrackerNotServingError> =>
	Effect.gen(function* () {
		const socketPath = socketPathFor(projectRoot);
		const child = spawn(process.execPath, [SELF_PATH, projectRoot], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
		yield* awaitSocketServing(socketPath, 50);
		return {pid: child.pid, socketPath};
	});

// Detached-child entry: when this module is the process entrypoint, run the standing tracker for the
// project root passed as argv[2]. `ensureTrackerRunning` re-enters here in the spawned child.
if (import.meta.main) {
	NodeRuntime.runMain(runStandingTracker(process.argv[2] ?? process.cwd()));
}
