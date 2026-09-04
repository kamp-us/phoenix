/**
 * The page side of the transport. `attach(url)` opens the one socket and hands back the two things
 * the window contract's `WindowHost` needs per process — `readProcess` and `dispatch` — plus the
 * process table and `readShell` over it.
 *
 * Nothing here is a page's own state. The maps below mirror what the kernel sent and are thrown
 * away with the socket: no layout, no focus, no view slot, no draft. That is the whole reason two
 * tabs on one shell show the same desk — there is nowhere for them to differ (#7556). A drop is not
 * repaired here either: attaching again is the repair, and the server replays current state rather
 * than a transcript, so a re-attached page is at the kernel's state and no dispatch happens twice.
 *
 * `SubscriptionRef` carries each process's state for the reason the window fixtures give: at the
 * pin (rc.112) its `make` builds a replaying `PubSub` and `changes` streams from it, so a reader
 * gets the current value first and then every update — which is exactly `readProcess`'s promise.
 */

import {Deferred, Effect, Option, Stream, SubscriptionRef} from "effect";
import {Socket} from "effect/unstable/socket";
import type {Message, ProcessId} from "../../process/process.ts";
import type {ProgramId} from "../../registry/program.ts";
import type {TableRow} from "../../table/row.ts";
import {type DispatchResult, delivered, type ProcessView, processGone} from "../window/host.ts";
import {type AttachRefused, NoSuchProcess, PlacementUnsupported} from "./errors.ts";
import {
	ATTACH_KIND,
	DETACH_KIND,
	DISPATCH_KIND,
	decodeServerFrame,
	encodeFrame,
	fromWireRow,
	type ServerFrame,
} from "./wire.ts";

/**
 * The shell program's registry id. The shell is a program like any other, so the page locates its
 * process by reading the table for this id rather than by any frame the wire keeps for it.
 */
export const SHELL_PROGRAM_ID = "tuval/shell" as ProgramId;

/** One attached process: the two `WindowHost` members a renderer is handed, bound to this process. */
export interface AttachedProcess<S = unknown, M extends Message = Message> {
	readonly processId: ProcessId;
	readonly readProcess: Stream.Stream<ProcessView<S>>;
	readonly dispatch: (msg: M) => Effect.Effect<DispatchResult>;
}

export interface PageAttachment {
	/** The kernel's process table, current rows first and then every change. */
	readonly rows: Stream.Stream<ReadonlyArray<TableRow>>;
	readonly attachProcess: <S = unknown, M extends Message = Message>(
		processId: ProcessId,
	) => Effect.Effect<AttachedProcess<S, M>, AttachRefused | Socket.SocketError>;
	/** Stop receiving one process's state. The process is untouched; only this socket's interest ends. */
	readonly detach: (processId: ProcessId) => Effect.Effect<void>;
	/** The shell process's state, over the same path as any other process's. */
	readonly readShell: <S = unknown>() => Stream.Stream<
		ProcessView<S>,
		AttachRefused | Socket.SocketError
	>;
}

export interface AttachOptions {
	/** Which program the shell is. A test shell is a different row, so this is a parameter. */
	readonly shellProgram?: ProgramId;
}

export const attach = Effect.fn("Tuval.transport.attach")(function* (
	url: string,
	options?: AttachOptions,
) {
	const shellProgram = options?.shellProgram ?? SHELL_PROGRAM_ID;
	const socket = yield* Socket.makeWebSocket(url);
	const write = yield* socket.writer;

	const rowsRef = yield* SubscriptionRef.make<ReadonlyMap<ProcessId, TableRow>>(new Map());
	const views = new Map<ProcessId, SubscriptionRef.SubscriptionRef<ProcessView<unknown>>>();
	const pendingAttach = new Map<ProcessId, Deferred.Deferred<void, AttachRefused>>();
	const pendingDispatch = new Map<number, Deferred.Deferred<DispatchResult>>();
	let nextSeq = 0;

	const opened = yield* Deferred.make<void>();
	/** Filled when the read loop ends: a refused handshake, a drop, or the scope closing. */
	const closed = yield* Deferred.make<never, Socket.SocketError>();

	const viewRef = (processId: ProcessId) =>
		Effect.suspend(() => {
			const existing = views.get(processId);
			if (existing !== undefined) return Effect.succeed(existing);
			return SubscriptionRef.make<ProcessView<unknown>>(processGone(processId)).pipe(
				Effect.tap((ref) => Effect.sync(() => void views.set(processId, ref))),
			);
		});

	const onFrame = (frame: ServerFrame): Effect.Effect<void> => {
		switch (frame.kind) {
			case "tuval/transport/table/v1":
				return SubscriptionRef.update(rowsRef, (rows) => {
					const next = new Map(rows);
					if (frame.event === "stopped") next.delete(frame.row.id);
					else next.set(frame.row.id, fromWireRow(frame.row));
					return next;
				});
			case "tuval/transport/process-state/v1":
				return Effect.gen(function* () {
					const ref = yield* viewRef(frame.processId);
					yield* SubscriptionRef.set(
						ref,
						frame.view._tag === "ProcessGone"
							? processGone(frame.processId)
							: ({
									_tag: "Live",
									processId: frame.processId,
									lifecycle: frame.view.lifecycle,
									revision: frame.view.revision,
									state: frame.view.state,
								} satisfies ProcessView<unknown>),
					);
					const pending = pendingAttach.get(frame.processId);
					if (pending !== undefined) {
						pendingAttach.delete(frame.processId);
						yield* Deferred.succeed(pending, undefined);
					}
				});
			case "tuval/transport/attach-refused/v1":
				return Effect.suspend(() => {
					const pending = pendingAttach.get(frame.processId);
					if (pending === undefined) return Effect.void;
					pendingAttach.delete(frame.processId);
					return Deferred.fail(
						pending,
						frame.refusal.reason === "placement-unsupported"
							? new PlacementUnsupported({
									processId: frame.processId,
									placement: frame.refusal.placement,
								})
							: new NoSuchProcess({processId: frame.processId}),
					);
				});
			case "tuval/transport/dispatched/v1":
				return Effect.suspend(() => {
					const pending = pendingDispatch.get(frame.seq);
					if (pending === undefined) return Effect.void;
					pendingDispatch.delete(frame.seq);
					return Effect.ignore(
						Deferred.succeed(
							pending,
							frame.result._tag === "Delivered" ? delivered : processGone(frame.result.processId),
						),
					);
				});
		}
	};

	/** A clean end of the read loop is still the socket going away for everyone waiting on it. */
	const socketEnded = () =>
		new Socket.SocketError({reason: new Socket.SocketCloseError({code: 1000})});

	yield* Effect.forkScoped(
		socket
			.runString(
				(text) => {
					const decoded = decodeServerFrame(text);
					// The server is the only writer on this socket, so a frame it sent that does not decode
					// means the two ends disagree about the wire: the page closes rather than guess.
					return decoded._tag === "Frame"
						? onFrame(decoded.frame)
						: Effect.ignore(
								write(new Socket.CloseEvent(1008, `undecodable frame: ${decoded.reason}`)),
							);
				},
				{onOpen: Effect.ignore(Deferred.succeed(opened, undefined))},
			)
			.pipe(
				Effect.catchCause((cause) => Effect.ignore(Deferred.failCause(closed, cause))),
				Effect.andThen(Effect.ignore(Deferred.fail(closed, socketEnded()))),
			),
	);

	yield* Effect.raceFirst(Deferred.await(opened), Deferred.await(closed));

	const attachProcess = <S = unknown, M extends Message = Message>(processId: ProcessId) =>
		Effect.gen(function* () {
			const gate = yield* Deferred.make<void, AttachRefused>();
			pendingAttach.set(processId, gate);
			yield* Effect.ignore(write(encodeFrame({kind: ATTACH_KIND, processId})));
			yield* Effect.raceFirst(Deferred.await(gate), Deferred.await(closed));
			const ref = yield* viewRef(processId);
			return {
				processId,
				readProcess: SubscriptionRef.changes(ref) as Stream.Stream<ProcessView<S>>,
				dispatch: (msg: M) =>
					Effect.gen(function* () {
						const seq = nextSeq++;
						const ack = yield* Deferred.make<DispatchResult>();
						pendingDispatch.set(seq, ack);
						yield* Effect.ignore(write(encodeFrame({kind: DISPATCH_KIND, seq, processId, msg})));
						// `WindowHost`'s dispatch never fails: a socket that went away is the process being
						// out of reach, which is `ProcessGone` — the same value a stopped process answers.
						return yield* Effect.raceFirst(Deferred.await(ack), Deferred.await(closed)).pipe(
							Effect.catchCause(() => Effect.succeed(processGone(processId))),
						);
					}),
			} satisfies AttachedProcess<S, M>;
		});

	const detach = (processId: ProcessId) =>
		Effect.ignore(write(encodeFrame({kind: DETACH_KIND, processId})));

	const readShell = <S = unknown>() =>
		Stream.unwrap(
			Effect.gen(function* () {
				const shell = yield* Stream.runHead(
					Stream.flatMap(SubscriptionRef.changes(rowsRef), (rows) => {
						const row = [...rows.values()].find((one) => one.programId === shellProgram);
						return row === undefined ? Stream.empty : Stream.succeed(row.id);
					}),
				).pipe(Effect.raceFirst(Deferred.await(closed)));
				if (Option.isNone(shell)) return Stream.empty;
				const attached = yield* attachProcess<S>(shell.value);
				return attached.readProcess;
			}),
		);

	return {
		rows: Stream.map(SubscriptionRef.changes(rowsRef), (rows) => [...rows.values()]),
		attachProcess,
		detach,
		readShell,
	} satisfies PageAttachment;
});
