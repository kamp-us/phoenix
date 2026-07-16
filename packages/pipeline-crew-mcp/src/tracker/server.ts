/**
 * tracker/server — the standing registry `RpcServer` over a per-project unix socket, and the
 * first-peer-spawn launch entry.
 *
 * The socket path is derived deterministically from the project root (`socketPathFor`), so every
 * peer of one project rendezvous on the same socket while different projects stay isolated — the
 * "per-project socket". The tracker is brought up by whichever peer needs it first (first-peer-
 * spawn): the first bind wins the socket; a later peer's bind gets `EADDRINUSE`, the signal that a
 * tracker is already serving this project, and it connects as a client instead.
 *
 * The served surface is `TrackerRegistry` — registry kinds only (see `./group.ts`); the tracker
 * has no handler for any message-relay kind, so it structurally cannot relay a message.
 */
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {NodeSocketServer} from "@effect/platform-node";
import {type Effect, Layer} from "effect";
import {RpcSerialization, RpcServer} from "effect/unstable/rpc";
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
 * First-peer-spawn entry: launch the tracker for `projectRoot` and keep it running until
 * interrupted (`Layer.launch` builds the server layer and blocks, closing it on teardown). A
 * `SocketServerError` from an already-bound socket means a tracker is already up for this project.
 */
export const launchTracker = (projectRoot: string): Effect.Effect<never, unknown> =>
	Layer.launch(trackerServerLayer(socketPathFor(projectRoot)));
