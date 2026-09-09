import {NodeServices} from "@effect/platform-node";
import {type Cause, Deferred, Effect, Queue, Schema, Scope, Stream} from "effect";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {TransportError} from "../ai-agent/service/index.ts";

export const RequestId = Schema.Union([Schema.String, Schema.Finite]);
export type RequestId = typeof RequestId.Type;
const Message = Schema.Union([
	Schema.Struct({id: RequestId, method: Schema.String, params: Schema.optionalKey(Schema.Unknown)}),
	Schema.Struct({
		method: Schema.String,
		id: Schema.optionalKey(Schema.Never),
		params: Schema.optionalKey(Schema.Unknown),
	}),
	Schema.Struct({id: RequestId, result: Schema.Json}),
	Schema.Struct({
		id: RequestId,
		error: Schema.Struct({code: Schema.Finite, message: Schema.String}),
	}),
]);

export interface ServerMessage {
	readonly method: string;
	readonly params: unknown;
	readonly id?: RequestId;
}

export interface CodexConnection {
	readonly request: (method: string, params: unknown) => Effect.Effect<unknown, TransportError>;
	readonly reply: (id: RequestId, result: unknown) => Effect.Effect<void, TransportError>;
	readonly reject: (id: RequestId, message: string) => Effect.Effect<void, TransportError>;
	readonly messages: Stream.Stream<ServerMessage, TransportError>;
}

export interface CodexCommand {
	readonly command?: string;
	readonly args?: ReadonlyArray<string>;
	readonly env?: Readonly<Record<string, string>>;
	readonly requestTimeoutMs?: number;
}

export const disconnected = (cause: unknown): TransportError =>
	new TransportError({reason: "disconnected", detail: String(cause)});
export const protocolError = (cause: unknown): TransportError =>
	new TransportError({reason: "protocol", detail: String(cause)});

// Requests and notifications share stdout, but replies must never wait behind a permission card.
export const connectCodex = (options: CodexCommand = {}) =>
	Effect.fn("Codex.connect")(function* (cwd: string) {
		const scope = yield* Scope.Scope;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const outgoing = yield* Queue.unbounded<Uint8Array>();
		const incoming = yield* Queue.unbounded<ServerMessage, TransportError | Cause.Done>();
		const pending = new Map<RequestId, Deferred.Deferred<unknown, TransportError>>();
		let failure: TransportError | null = null;
		let sequence = 0;
		const encoder = new TextEncoder();
		// Completing a pending request can cancel the timeout fiber doing this cleanup.
		const fail = Effect.fn("Codex.transport.fail")(function* (error: TransportError) {
			if (failure !== null) return;
			failure = error;
			for (const deferred of pending.values()) yield* Deferred.fail(deferred, error);
			pending.clear();
			yield* Queue.fail(incoming, error);
			yield* Queue.shutdown(outgoing);
		}, Effect.uninterruptible);
		const send = (message: unknown): Effect.Effect<void, TransportError> =>
			Effect.suspend(() =>
				failure !== null
					? Effect.fail(failure)
					: Effect.asVoid(Queue.offer(outgoing, encoder.encode(`${JSON.stringify(message)}\n`))),
			);
		const handle = yield* spawner
			.spawn(
				ChildProcess.make(options.command ?? "codex", options.args ?? ["app-server"], {
					cwd,
					stdin: Stream.fromQueue(outgoing),
					stdout: "pipe",
					stderr: "pipe",
					env: options.env,
					extendEnv: true,
					killSignal: "SIGTERM",
					forceKillAfter: 1000,
				}),
			)
			.pipe(Effect.mapError(disconnected));
		yield* Effect.addFinalizer(() =>
			fail(disconnected("Codex connection closed")).pipe(Effect.andThen(Queue.shutdown(incoming))),
		);
		const receive = Effect.fn("Codex.transport.receive")(function* (line: string) {
			const frame = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Message))(line).pipe(
				Effect.mapError(protocolError),
			);
			if ("method" in frame) {
				yield* Queue.offer(incoming, {
					method: frame.method,
					params: frame.params,
					...(frame.id === undefined ? {} : {id: frame.id}),
				});
				return;
			}
			const waiting = pending.get(frame.id);
			if (waiting === undefined) return;
			pending.delete(frame.id);
			yield* "error" in frame
				? Deferred.fail(
						waiting,
						new TransportError({reason: "refused", detail: frame.error.message}),
					)
				: Deferred.succeed(waiting, frame.result);
		});
		yield* handle.stdout.pipe(
			Stream.decodeText(),
			Stream.splitLines,
			Stream.filter((line) => line.length > 0),
			Stream.runForEach(receive),
			Effect.mapError((error) => (error instanceof TransportError ? error : disconnected(error))),
			Effect.andThen(fail(disconnected("Codex stdout closed"))),
			Effect.catch(fail),
			Effect.forkIn(scope),
		);
		// Drain stderr without putting local paths or credentials into the transcript.
		yield* handle.stderr.pipe(
			Stream.runDrain,
			Effect.catch((error) => fail(disconnected(error))),
			Effect.forkIn(scope),
		);
		yield* handle.exitCode.pipe(
			Effect.flatMap((code) => fail(disconnected(`Codex exited with code ${code}`))),
			Effect.catch((error) => fail(disconnected(error))),
			Effect.forkIn(scope),
		);
		const request = Effect.fn("Codex.request")(function* (method: string, params: unknown) {
			const id = `tuval-${++sequence}`;
			const waiting = yield* Deferred.make<unknown, TransportError>();
			pending.set(id, waiting);
			return yield* send({id, method, params}).pipe(
				Effect.andThen(Deferred.await(waiting)),
				Effect.timeoutOrElse({
					duration: options.requestTimeoutMs ?? 30_000,
					orElse: () => {
						const error = disconnected(`Codex did not answer ${method}`);
						return fail(error).pipe(Effect.andThen(Effect.fail(error)));
					},
				}),
				Effect.ensuring(Effect.sync(() => pending.delete(id))),
			);
		});
		yield* request("initialize", {
			clientInfo: {name: "tuval", title: "Tuval", version: "0.0.0"},
			capabilities: {experimentalApi: true},
		});
		yield* send({method: "initialized"});
		return {
			request,
			reply: (id, result) => send({id, result}),
			reject: (id, message) => send({id, error: {code: -32601, message}}),
			messages: Stream.fromQueue(incoming),
		} satisfies CodexConnection;
	});

export type CodexConnect = (
	cwd: string,
) => Effect.Effect<CodexConnection, TransportError, Scope.Scope>;

export const nodeConnection =
	(options: CodexCommand): CodexConnect =>
	(cwd) =>
		connectCodex(options)(cwd).pipe(Effect.provide(NodeServices.layer));
