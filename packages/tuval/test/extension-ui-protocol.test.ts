import {NodeServices} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber} from "effect";
import {makeExtensionUI} from "../src/backend/extension-ui.js";
import {startTuval} from "../src/backend/server.js";
import type {ExtensionUIScope} from "../src/shared/extension-ui.js";
import {tryPromise} from "./test-effect.js";

const scope: ExtensionUIScope = {packageName: "protocol-fixture", sessionId: "session-rpc"};
const fate = (url: string, operations: ReadonlyArray<Record<string, unknown>>) =>
	tryPromise(() =>
		fetch(`${url}/fate`, {
			method: "POST",
			headers: {"content-type": "application/json"},
			body: JSON.stringify({version: 1, operations}),
		}).then((response) => response.json()),
	);

const readFrame = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
	tryPromise(() => reader.read()).pipe(Effect.map(({value}) => new TextDecoder().decode(value)));

describe("extension UI fate/SSE protocol", () => {
	it.layer(NodeServices.layer)((it) => {
		it.effect("routes scoped state, blocking response, duplicate rejection, and unload", () =>
			Effect.gen(function* () {
				const extensionUI = makeExtensionUI();
				const server = yield* startTuval({extensionUI, openBrowser: () => Effect.void});
				const abort = new AbortController();
				yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()));
				const stream = yield* tryPromise(() =>
					fetch(`${server.url}/fate/extension-ui/live`, {signal: abort.signal}),
				);
				assert.include(stream.headers.get("content-type") ?? "", "text/event-stream");
				const reader = stream.body!.getReader();

				yield* extensionUI.dispatch(scope, {
					type: "extension_ui_request",
					id: "status",
					method: "setStatus",
					statusKey: "phase",
					statusText: "waiting",
				});
				assert.include(yield* readFrame(reader), '"_tag":"status"');

				const current = (yield* fate(server.url, [
					{id: "current", kind: "query", name: "extensionUi.current", select: []},
				])) as {results: Array<{data: Array<{scope: ExtensionUIScope}>}>};
				assert.deepStrictEqual(current.results[0]?.data[0]?.scope, scope);

				const pending = yield* Effect.forkChild(
					extensionUI.dispatch(scope, {
						type: "extension_ui_request",
						id: "confirm",
						method: "confirm",
						title: "Continue?",
						message: "No implicit approval",
					}),
				);
				assert.include(yield* readFrame(reader), '"method":"confirm"');
				const responseOperation = {
					id: "respond",
					kind: "mutation",
					name: "extensionUi.respond",
					input: {
						scope,
						response: {type: "extension_ui_response", id: "confirm", confirmed: false},
					},
					select: [],
				};
				const responded = (yield* fate(server.url, [responseOperation])) as {
					results: Array<{data: {_tag: string}}>;
				};
				assert.strictEqual(responded.results[0]?.data._tag, "accepted");
				const completed = yield* Fiber.join(pending);
				assert.strictEqual(completed._tag, "responded");
				if (completed._tag === "responded" && "confirmed" in completed.response) {
					assert.isFalse(completed.response.confirmed);
				}
				const duplicate = (yield* fate(server.url, [responseOperation])) as {
					results: Array<{data: {_tag: string}}>;
				};
				assert.strictEqual(duplicate.results[0]?.data._tag, "duplicate");

				const unloaded = (yield* fate(server.url, [
					{id: "unload", kind: "mutation", name: "extensionUi.unload", input: {scope}, select: []},
				])) as {results: Array<{data: {_tag: string}}>};
				assert.strictEqual(unloaded.results[0]?.data._tag, "unloaded");
				assert.deepStrictEqual(yield* extensionUI.snapshots(), []);
				yield* server.close();
			}),
		);
	});
});
