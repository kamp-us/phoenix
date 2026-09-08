import {Effect, Exit, Schema, Stream} from "effect";
import {describe, expect, it} from "vitest";
import {nodeConnection} from "./transport.ts";

const connect = nodeConnection({
	command: process.execPath,
	args: [new URL("./fixtures/app-server.ts", import.meta.url).pathname],
	requestTimeoutMs: 1000,
});

describe("Codex JSONL connection over a real OS process", () => {
	it("matches replies, decodes split UTF-8 and routes server requests separately", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* connect(import.meta.dirname);
					expect(yield* connection.request("test/unicode", {})).toBe("🦊");
					expect(yield* connection.request("test/approval", {})).toEqual({accepted: true});
					expect(yield* connection.messages.pipe(Stream.take(1), Stream.runCollect)).toEqual([
						{
							id: 42,
							method: "item/commandExecution/requestApproval",
							params: {threadId: "session"},
						},
					]);
					yield* connection.reply(42, {decision: "decline"});
					expect(yield* connection.request("test/readReply", {})).toEqual({decision: "decline"});
				}),
			),
		);
	});

	it("keeps RPC refusals distinct from broken transport and can make another request", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* connect(import.meta.dirname);
					const error = yield* connection.request("test/error", {}).pipe(Effect.flip);
					expect(error.reason).toBe("refused");
					expect(error.detail).toBe("Refused by fixture");
					expect(yield* connection.request("echo", {ok: true})).toEqual({ok: true});
				}),
			),
		);
	});

	it.each([
		"test/exit",
		"test/malformed",
		"test/hang",
	])("fails outstanding requests and the event stream after %s", async (method) => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* connect(import.meta.dirname);
					const result = yield* Effect.exit(connection.request(method, {}));
					expect(Exit.isFailure(result)).toBe(true);
					expect(
						Exit.isFailure(
							yield* Effect.exit(connection.messages.pipe(Stream.take(1), Stream.runCollect)),
						),
					).toBe(true);
					expect(Exit.isFailure(yield* Effect.exit(connection.request("echo", {})))).toBe(true);
				}),
			),
		);
	});

	it("waits for the child to exit when the owning scope closes", async () => {
		const pid = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* connect(import.meta.dirname);
					return yield* connection
						.request("test/pid", {})
						.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Finite)));
				}),
			),
		);
		expect(() => process.kill(pid, 0)).toThrow();
	});
});
