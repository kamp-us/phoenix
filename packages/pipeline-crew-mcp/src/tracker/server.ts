/**
 * tracker/server — the standing registry `RpcServer` over a per-project unix socket: the raw
 * `trackerServerLayer` bind, the standalone `launchTracker` entry, and the `EADDRINUSE` detector
 * (`isTrackerAddressInUse`) the first-peer-spawn dial fallback keys on.
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
 * The served surface is `TrackerRegistry` — registry kinds only (see `./group.ts`); the tracker
 * has no handler for any message-relay kind, so it structurally cannot relay a message.
 */
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {NodeSocketServer} from "@effect/platform-node";
import {Cause, type Effect, Layer, Option} from "effect";
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
 * The composed tracker server layer: the registry `RpcServer` (its handlers over `RegistryLive`)
 * bound to a unix `SocketServer` at `socketPath`, NDJSON-framed. Building the layer starts the
 * server listening on a scoped fiber; closing the scope stops it. Its error channel carries the
 * `SocketServerError` a failed bind (e.g. `EADDRINUSE`) raises.
 */
export const trackerServerLayer = (socketPath: string) =>
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
