/**
 * tracker/server — the standing registry `RpcServer` over a per-project unix socket: the
 * `trackerServerLayer` bind (with stale-socket reclamation), the standalone `launchTracker` entry,
 * and the `EADDRINUSE` detector (`isTrackerAddressInUse`) the first-peer-spawn dial fallback keys on.
 *
 * The socket path is derived deterministically from the project root (`socketPathFor`), so every
 * peer of one project rendezvous on the same socket while different projects stay isolated — the
 * "per-project socket". The tracker is brought up by whichever peer needs it first (first-peer-
 * spawn): the first bind wins the socket; a later peer's bind gets `EADDRINUSE`, the signal that a
 * tracker is already serving this project, and it connects as a client instead. That host-or-dial
 * wiring — which combines this server layer with the crew's registry client — lives in
 * `../crew/tracker.ts` (`crewTrackerHostOrDialLayer`), because it needs both halves; this module
 * owns only the server half plus the bind-error primitive that path branches on.
 *
 * Crash recovery lives here too (#3280): a unix socket *file* survives an ungraceful host exit —
 * crash / SIGKILL runs no scope teardown, and node only unlinks the file on a CLEAN `server.close()`,
 * so the file is left orphaned. That stale file would poison the next spawn — its bind still fails
 * `EADDRINUSE`, so the caller dials, but the dial hits `ECONNREFUSED` (nothing listening) and the
 * whole project wedges until someone `rm`s the file. `trackerServerLayer` therefore reclaims a
 * *stale* socket at bind time (`reclaimStaleSocket`); the liveness probe is what keeps that reclaim
 * from racing a genuinely-live host offline — it unlinks ONLY on a proven-refused connect.
 *
 * The served surface is `TrackerRegistry` — registry kinds only (see `./group.ts`); the tracker
 * has no handler for any message-relay kind, so it structurally cannot relay a message.
 */
import {createHash} from "node:crypto";
import {unlink} from "node:fs";
import {connect} from "node:net";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {NodeSocketServer} from "@effect/platform-node";
import {Cause, Effect, Layer, Option} from "effect";
import {RpcSerialization, RpcServer} from "effect/unstable/rpc";
import {SocketServerError} from "effect/unstable/socket/SocketServer";
import {TrackerRegistry} from "./group.ts";
import {TrackerHandlers} from "./handlers.ts";
import {RegistryLive} from "./registry.ts";

/**
 * The per-project unix socket path for `projectRoot`. Deterministic (same project ⇒ same socket)
 * yet collision-free across projects, and short enough to stay under the ~104-char unix socket
 * path limit by hashing the root rather than embedding it. Honors `XDG_RUNTIME_DIR` when set,
 * falling back to the OS temp dir.
 */
export const socketPathFor = (projectRoot: string): string => {
	const digest = createHash("sha256").update(resolve(projectRoot)).digest("hex").slice(0, 16);
	const base = process.env.XDG_RUNTIME_DIR ?? tmpdir();
	return join(base, `kampus-crew-${digest}.sock`);
};

/**
 * Reclaim a *stale* unix socket at `socketPath` before a bind: unlink the file iff a connect to it
 * is definitively refused (`ECONNREFUSED` — the file exists but no host listens, the crash-path
 * signature grounded in node's `net` semantics, see `probeStaleSocket`). Any other outcome leaves
 * the file untouched: a live host (connect succeeds) is dialed by the caller, not reclaimed out from
 * under it (#3280 AC — never an unconditional unlink); an absent file (`ENOENT`) is the normal
 * first-spawn and needs no reclaim; an ambiguous error is left for the real bind to surface. The
 * unlink is best-effort — if a concurrent peer reclaimed+rebound in the probe→unlink window, our
 * bind then loses the race with `EADDRINUSE` and the caller dials, the same convergence as a live host.
 */
export const reclaimStaleSocket = (socketPath: string): Effect.Effect<void> =>
	probeStaleSocket(socketPath).pipe(
		Effect.flatMap((isStale) =>
			isStale
				? Effect.callback<void>((resume) => {
						unlink(socketPath, () => resume(Effect.void));
					})
				: Effect.void,
		),
	);

/**
 * Probe whether `socketPath` is a *stale* socket — a file present on disk with nothing listening.
 * Grounded in node `net` connect semantics (verified against the real platform, #3280): a live
 * listener answers with `"connect"`; a crashed host's orphaned socket file refuses with
 * `ECONNREFUSED`; an absent path errors `ENOENT`. Stale is EXACTLY `ECONNREFUSED` — every other
 * outcome (connected, `ENOENT`, or any other error such as a non-socket file's `ENOTSOCK`) is
 * reported not-stale, so the caller never unlinks a live or ambiguous socket.
 */
const probeStaleSocket = (socketPath: string): Effect.Effect<boolean> =>
	Effect.callback<boolean>((resume) => {
		const sock = connect(socketPath);
		const settle = (isStale: boolean) => {
			sock.removeAllListeners();
			sock.destroy();
			resume(Effect.succeed(isStale));
		};
		sock.once("connect", () => settle(false));
		sock.once("error", (error) => settle((error as NodeJS.ErrnoException).code === "ECONNREFUSED"));
	});

/**
 * The composed tracker server layer: the registry `RpcServer` (its handlers over `RegistryLive`)
 * bound to a unix `SocketServer` at `socketPath`, NDJSON-framed. Building the layer starts the
 * server listening on a scoped fiber; closing the scope stops it. Its error channel carries the
 * `SocketServerError` a failed bind (e.g. `EADDRINUSE`) raises.
 *
 * `reclaimStaleSocket` runs first (sequenced by `Layer.unwrap`) so a crashed host's orphaned socket
 * is cleared before the bind — the crash-recovery contract in the module docblock (#3280). A live
 * host's socket is left intact, so a genuine second peer still hits `EADDRINUSE` and dials it.
 */
export const trackerServerLayer = (socketPath: string) =>
	Layer.unwrap(reclaimStaleSocket(socketPath).pipe(Effect.as(boundTrackerServerLayer(socketPath))));

/** The raw bind, no reclamation — `trackerServerLayer` runs `reclaimStaleSocket` ahead of this. */
const boundTrackerServerLayer = (socketPath: string) =>
	RpcServer.layer(TrackerRegistry).pipe(
		Layer.provide(TrackerHandlers.pipe(Layer.provide(RegistryLive))),
		Layer.provide(
			RpcServer.layerProtocolSocketServer.pipe(
				Layer.provide([RpcSerialization.layerNdjson, NodeSocketServer.layer({path: socketPath})]),
			),
		),
	);

/**
 * Standalone tracker entry: launch a dedicated tracker for `projectRoot` and keep it running until
 * interrupted (`Layer.launch` builds the server layer and blocks, closing it on teardown). Drives
 * the bin's `tracker` subcommand — the explicit way to stand a project's tracker up decoupled from
 * any role session. It fails fast with a `SocketServerError` when the socket is already bound
 * (`isTrackerAddressInUse`), the signal that a tracker is already up for this project; the caller
 * decides whether that is a clean no-op (the subcommand treats it as "already serving").
 *
 * A live crew session does NOT use this blocking entry — it hosts the tracker as a scoped layer via
 * `crewTrackerHostOrDialLayer` (first-peer-spawn), so the server runs alongside the session rather
 * than blocking it.
 */
export const launchTracker = (projectRoot: string): Effect.Effect<never, unknown> =>
	Layer.launch(trackerServerLayer(socketPathFor(projectRoot)));

/**
 * Is this cause a tracker-socket bind that lost the race — an `EADDRINUSE` raised while opening the
 * server? The first-peer-spawn signal that a tracker is already serving the socket, so the caller
 * should dial the existing one instead of failing. Narrow on purpose: a non-`EADDRINUSE` bind
 * failure (bad permissions, a missing runtime dir) is a real error that must propagate, never be
 * silently swallowed into a dial that would only fail more opaquely.
 */
export const isTrackerAddressInUse = (cause: Cause.Cause<unknown>): boolean =>
	Option.match(Cause.findErrorOption(cause), {
		onNone: () => false,
		onSome: (error) =>
			error instanceof SocketServerError &&
			error.reason._tag === "SocketServerOpenError" &&
			(error.reason.cause as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE",
	});
