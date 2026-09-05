/**
 * The Node side of the page-to-kernel transport: one WebSocket per page, the tmux server/client
 * shape (#7547 R1.3). The kernel and every process stay here; the page is a view, and every page
 * over one shell process sees the same desk because the state it renders is the process's, not
 * its own (#7556, founder ruling 2026-09-02).
 *
 * One socket carries two subscriptions the server owns from the moment it opens, before any frame
 * the page sends: the process-table port (#7516), whose every change goes out as a `table` frame,
 * and the table's own change stream, whose changes go out as `process-state` frames for the
 * processes this socket attached to. Both start first on purpose — a subscription opened when the
 * attach arrives would miss whatever committed between the read and the subscribe.
 *
 * There is no shell frame here. The shell process's state leaves on the same `process-state` frame
 * as any other process's, and the page finds its shell by reading the table.
 *
 * The catalog of windowed programs goes out the same way: read off the registry as the socket opens,
 * and re-read on `publishRegistry`, never held as a snapshot taken when the server started (#7788).
 */

import type {IncomingMessage} from "node:http";
import {NodeSocketServer} from "@effect/platform-node";
import {Context, Deferred, Effect, type Option, type Redacted, Stream} from "effect";
import {Socket, type SocketServer} from "effect/unstable/socket";
import {ProcessTable} from "../../process/ProcessTable.ts";
import type {ProcessChange, ProcessHandle, ProcessId} from "../../process/process.ts";
import {type AnyProgram, programLabel} from "../../registry/program.ts";
import {Registry} from "../../registry/Registry.ts";
import {ProcessTablePort} from "../../table/ProcessTablePort.ts";
import {showsInAWindow} from "../picker/entries.ts";
import {checkHandshake, launchUrl, loopbackOrigins} from "./handshake.ts";
import {
	ATTACH_REFUSED_KIND,
	type ClientFrame,
	DISPATCHED_KIND,
	decodeClientFrame,
	encodeFrame,
	PROCESS_STATE_KIND,
	type ProcessStateFrame,
	REGISTRY_KIND,
	type RegistryFrame,
	type ServerFrame,
	TABLE_KIND,
	tableFrame,
	toWireRow,
} from "./wire.ts";

/**
 * Where a process handle comes from. An Effect, because the answer moves: a process the picker
 * spawned after this server started is dispatchable too, and a caller that had to hand over a
 * snapshot map could only ever serve the processes that existed at boot. `Processes.handle` is what
 * `boot` passes here.
 */
export type Handles = (id: ProcessId) => Effect.Effect<Option.Option<ProcessHandle>>;

export interface ServeOptions {
	readonly token: Redacted.Redacted<string>;
	/** `0` binds an ephemeral port, which is what a test wants and what a launch can take. */
	readonly port: number;
	readonly host?: string;
	readonly handles: Handles;
}

export interface TransportServer {
	readonly port: number;
	/**
	 * Re-read the registry and send its windowed programs to every attached page. A reload changes
	 * what a kernel offers, and a page cannot ask — a spell call is the only message it may send
	 * (#7617) — so the kernel pushes. Nothing calls this on the reload path yet: `Booted.reload`
	 * replaces the spell registry and leaves the program registry alone (#7743).
	 */
	readonly publishRegistry: Effect.Effect<void>;
	/** The one URL the launch prints: the address plus the launch token, and nothing else secret. */
	readonly launchUrl: string;
	/**
	 * Admit the loopback origins of one more port. The page server binds after the transport and on
	 * its own port, so the `Origin` a browser carries on the upgrade is not knowable when the fence
	 * is built; the launch admits it once Vite has listened (#7560). Only a port can be named, so
	 * nothing widens this to a remote origin.
	 */
	readonly admitLoopbackPort: (port: number) => void;
}

/**
 * Everything one socket keeps. Exactly one field, and it is the set of process ids this socket
 * asked for: no layout, no focus, no view, no draft — a page's UI state lives in the shell and
 * program processes, so a second tab attaching to the same shell sees the same desk (#7556).
 */
export interface SocketSession {
	readonly attached: Set<ProcessId>;
}

const CLOSE_POLICY = 1008;

/** Every attached page's writer. A catalog change reaches the pages already open through these. */
type Attached = Set<(frame: ServerFrame) => Effect.Effect<void>>;

/**
 * The registry's windowed programs, as one frame. `showsInAWindow` is the filter, so the headless
 * test stays in the one place that owns it (`../picker/entries.ts`) and never grows a second reading
 * here.
 */
export const registryFrame = (rows: ReadonlyArray<AnyProgram>): RegistryFrame => ({
	kind: REGISTRY_KIND,
	programs: rows.filter(showsInAWindow).map((row) => ({
		programId: row.id,
		label: programLabel(row),
		renderer: row.renderer,
	})),
});

const stateFrame = (processId: ProcessId, change: ProcessChange): ProcessStateFrame => {
	if (change.kind === "stopped") {
		return {kind: PROCESS_STATE_KIND, processId, view: {_tag: "ProcessGone"}};
	}
	const summary = change.row.stateSummary();
	return {
		kind: PROCESS_STATE_KIND,
		processId,
		view: {
			_tag: "Live",
			lifecycle: summary.lifecycle,
			revision: summary.revision,
			state: summary.state,
		},
	};
};

export const serve = Effect.fn("Tuval.transport.serve")(function* (options: ServeOptions) {
	const table = yield* ProcessTable;
	const tablePort = yield* ProcessTablePort;
	const registry = yield* Registry;
	const services = Context.make(ProcessTable, table).pipe(
		Context.add(ProcessTablePort, tablePort),
		Context.add(Registry, registry),
	);

	// `verifyClient` runs after `listen`, so the bound port is in this set by the time an upgrade can
	// reach it. Empty until then, which is the fence failing closed on a request that races the bind.
	const admitted = new Set<string>();
	const admitLoopbackPort = (port: number) => {
		for (const origin of loopbackOrigins(port)) admitted.add(origin);
	};

	const host = options.host ?? "127.0.0.1";
	const server: SocketServer.SocketServer["Service"] = yield* NodeSocketServer.makeWebSocket({
		host,
		port: options.port,
		// `ws` runs this during the upgrade: a `false` answers 401 and no connection event fires, so
		// a refused page never reaches a frame (`ws`'s `verifyClient`, the sync form).
		verifyClient: (info: {readonly req: IncomingMessage}) =>
			checkHandshake({url: info.req.url, origin: info.req.headers.origin}, options.token, admitted)
				._tag === "Accepted",
	});
	const address = server.address;
	if (address._tag !== "TcpAddress") {
		// `makeWebSocket` was given a port, so `ws` listened on TCP; a unix address cannot occur here.
		return yield* Effect.die(
			new Error("tuval transport: the socket server did not bind a TCP port"),
		);
	}
	admitLoopbackPort(address.port);

	const pages: Attached = new Set();
	yield* Effect.forkScoped(
		server.run((socket) =>
			Effect.scoped(session(socket, options.handles, pages)).pipe(Effect.provideContext(services)),
		),
	);

	const publishRegistry = Effect.gen(function* () {
		const frame = registryFrame(yield* registry.list);
		// One page at a time: a write is a queued frame, not a round trip, and a serial walk keeps the
		// publish a single point in time for every page rather than a fan nothing orders.
		yield* Effect.forEach(pages, (send) => send(frame), {discard: true, concurrency: 1});
	});

	return {
		port: address.port,
		launchUrl: launchUrl({port: address.port, token: options.token, host}),
		admitLoopbackPort,
		publishRegistry,
	} satisfies TransportServer;
});

const session = Effect.fn("Tuval.transport.session")(function* (
	socket: Socket.Socket,
	handles: Handles,
	pages: Attached,
) {
	const table = yield* ProcessTable;
	const tablePort = yield* ProcessTablePort;
	const registry = yield* Registry;
	const state: SocketSession = {attached: new Set<ProcessId>()};

	const write = yield* socket.writer;
	// A write races the socket's own close; losing that race is the close, never this fiber's failure.
	const send = (frame: ServerFrame) => Effect.ignore(write(encodeFrame(frame)));
	const close = (reason: string) =>
		Effect.ignore(write(new Socket.CloseEvent(CLOSE_POLICY, reason)));
	yield* Effect.addFinalizer(() => Effect.sync(() => void pages.delete(send)));

	const attach = Effect.fn("Tuval.transport.attach")(function* (processId: ProcessId) {
		const row = yield* Effect.option(table.get(processId));
		if (row._tag === "None") {
			return yield* send({
				kind: ATTACH_REFUSED_KIND,
				processId,
				refusal: {reason: "no-such-process"},
			});
		}
		const program = yield* Effect.orDie(registry.resolve(row.value.programId));
		if (program.placement.host !== "local") {
			return yield* send({
				kind: ATTACH_REFUSED_KIND,
				processId,
				refusal: {reason: "placement-unsupported", placement: program.placement.host},
			});
		}
		// Marked before the read, so a commit landing between the two goes out on the pump and the
		// read that follows can only be the same revision or a newer one — never a stale overwrite.
		state.attached.add(processId);
		const summary = row.value.stateSummary();
		yield* send({
			kind: PROCESS_STATE_KIND,
			processId,
			view: {
				_tag: "Live",
				lifecycle: summary.lifecycle,
				revision: summary.revision,
				state: summary.state,
			},
		});
	});

	const dispatch = Effect.fn("Tuval.transport.dispatch")(function* (
		seq: number,
		processId: ProcessId,
		msg: {readonly type: string},
	) {
		const handle = yield* handles(processId);
		if (handle._tag === "None") {
			return yield* send({
				kind: DISPATCHED_KIND,
				seq,
				result: {_tag: "ProcessGone", processId},
			});
		}
		// `dispatch` fails four ways and they do not mean the same thing, so each arm is named. A
		// blanket catch answered Delivered for all of them, which acknowledged a Msg the actor threw
		// away and hid a broken checkpoint write entirely (#7499).
		const gone = yield* handle.value.dispatch(msg).pipe(
			Effect.as(false),
			Effect.catchTags({
				// Stopped, or draining and refusing new Msgs: the Msg was not applied and never will
				// be, so `ProcessGone` is the only honest ack the wire has (`../window/host.ts`).
				"tuval/host/ActorStoppedError": () => Effect.succeed(true),
				DispatchDiscardedError: () => Effect.succeed(true),
				// The Msg was applied; the checkpoint behind it was not. Durability is broken and
				// nothing else surfaces it, so it is logged here and the ack stays Delivered.
				"tuval/host/StoreError": (error) =>
					Effect.logError("tuval transport: the checkpoint write for a dispatched Msg failed", {
						processId,
						operation: error.operation,
						cause: error.cause,
					}).pipe(Effect.as(false)),
			}),
			// A handler's own failure is not the window's: the Msg reached a live process, so the ack
			// says Delivered and the failure comes back through the state stream.
			Effect.orElseSucceed(() => false),
			// A defect from the actor fiber is nobody's declared failure; it is still not silence.
			Effect.catchCause((cause) =>
				Effect.logError("tuval transport: a dispatched Msg died in the actor", {
					processId,
					cause,
				}).pipe(Effect.as(false)),
			),
		);
		yield* send({
			kind: DISPATCHED_KIND,
			seq,
			result: gone ? {_tag: "ProcessGone", processId} : {_tag: "Delivered"},
		});
	});

	const onFrame = (frame: ClientFrame): Effect.Effect<void> => {
		switch (frame.kind) {
			case "tuval/transport/attach/v1":
				return attach(frame.processId);
			case "tuval/transport/detach/v1":
				return Effect.sync(() => void state.attached.delete(frame.processId));
			case "tuval/transport/dispatch/v1":
				return dispatch(frame.seq, frame.processId, frame.msg);
		}
	};

	/**
	 * The two subscriptions and the table snapshot, run as the socket's `onOpen`. They cannot run
	 * before it: at the pin, `Socket`'s writer waits on a latch the run itself opens, so a frame
	 * sent ahead of the read loop deadlocks the socket it is trying to greet
	 * (`effect/unstable/socket/Socket`'s `fromWebSocket`).
	 */
	const scope = yield* Effect.scope;
	const ready = yield* Deferred.make<void>();
	const greet = Effect.gen(function* () {
		yield* Effect.forkIn(
			Stream.runForEach(tablePort.changes, (event) => send(tableFrame(event))),
			scope,
		);
		yield* Effect.forkIn(
			Stream.runForEach(table.changes, (change) =>
				state.attached.has(change.row.id) ? send(stateFrame(change.row.id, change)) : Effect.void,
			),
			scope,
		);
		yield* send(registryFrame(yield* registry.list));
		for (const row of yield* tablePort.rows) {
			yield* send({kind: TABLE_KIND, event: "spawned", row: toWireRow(row)});
		}
		// Registered last: `send` writes through a writer the read loop's latch opens, so a publish
		// racing this greet would deadlock the very socket it is greeting.
		yield* Effect.sync(() => void pages.add(send));
		yield* Effect.ignore(Deferred.succeed(ready, undefined));
	});

	yield* socket.runString(
		(text) => {
			const decoded = decodeClientFrame(text);
			// A frame can land while `greet` is still forking the pumps; waiting here is what keeps an
			// attach from marking a process before the stream that serves it is running.
			return Deferred.await(ready).pipe(
				Effect.andThen(
					decoded._tag === "Frame"
						? onFrame(decoded.frame)
						: close(`undecodable frame: ${decoded.reason}`),
				),
			);
		},
		{onOpen: greet},
	);
});
