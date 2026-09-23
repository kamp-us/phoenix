import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {retaining} from "../diagnostics.ts";
import {createServerMessageDecoder, encodeServerMessage} from "../wire/codec.ts";
import {type DispatchContext, dispatch} from "./dispatch.ts";
import {SessionCallFailed, SessionOpenFailed} from "./errors.ts";
import {makeScriptedHost} from "./fixtures.ts";
import {PiSessionHost} from "./PiSessionHost.ts";
import {makeSessionRecords} from "./records.ts";

const privateDetail = "SYNTHETIC-PRIVATE-DIAGNOSTIC-8509";
const original = new Error(privateDetail);
const serverId = "00000000-0000-4000-8000-000000000001";

describe("Pi exception boundary before protocol 8 encoding", () => {
	it.effect("logs local create/resume/call failures while encoding only deliberate refusals", () =>
		Effect.gen(function* () {
			const host = yield* PiSessionHost;
			const opened = yield* host.open({cwd: "/workspace"});
			const failedCall = retaining(
				original,
				new SessionCallFailed({sessionId: opened.id, call: "prompt", detail: privateDetail}),
			);
			const failedOpen = retaining(
				original,
				new SessionOpenFailed({cwd: privateDetail, detail: privateDetail}),
			);
			const records = makeSessionRecords();
			records.insert(
				{...opened, prompt: () => Effect.fail(failedCall)},
				"connection",
				"attachment",
				0,
			);
			const context: DispatchContext = {
				connection: "connection",
				serverId,
				records,
				now: () => 0,
				onChanged: () => Effect.void,
				host: {...host, open: () => Effect.fail(failedOpen), resume: () => Effect.fail(failedOpen)},
			};
			const cases = [
				{
					target: {serverId},
					command: {command: "create", cwd: "/workspace"},
					code: "internal_error",
					message: "Pi could not create the session",
				},
				{
					target: {serverId},
					command: {command: "attach", sessionId: "missing"},
					code: "not_found",
					message: "no session missing",
				},
				{
					target: {serverId, sessionId: opened.id, attachmentId: "attachment"},
					command: {command: "prompt", sessionId: opened.id, text: "hello"},
					code: "internal_error",
					message: "Pi could not complete prompt",
				},
			] as const;
			for (const entry of cases) {
				const answer = yield* dispatch(context, entry.target, entry.command);
				assert.isFalse(answer.ok);
				if (answer.ok) continue;
				assert.deepStrictEqual(answer.error, {code: entry.code, message: entry.message});
				const encoded = encodeServerMessage({
					type: "response",
					id: "failure",
					ok: false,
					error: answer.error,
				});
				const decoded = createServerMessageDecoder().push(encoded);
				assert.notInclude(JSON.stringify(decoded), privateDetail);
				assert.strictEqual(decoded.length, 1);
			}
			assert.strictEqual(failedOpen.cause, original);
			assert.strictEqual(failedCall.cause, original);
		}).pipe(Effect.provide(makeScriptedHost().layer)),
	);
});
