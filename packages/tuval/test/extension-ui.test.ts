import type {RpcExtensionUIRequest} from "@earendil-works/pi-coding-agent";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Queue} from "effect";
import {
	type ExtensionUIScheduler,
	makeDurableExtensionUI,
	makeExtensionUI,
} from "../src/backend/extension-ui.js";
import {
	type ExtensionUIEvent,
	type ExtensionUIScope,
	exhaustiveRequestPin,
	extensionUIMethods,
} from "../src/shared/extension-ui.js";

const scope: ExtensionUIScope = {packageName: "fixture-extension", sessionId: "session-one"};
const request = <Method extends RpcExtensionUIRequest["method"]>(
	value: Extract<RpcExtensionUIRequest, {method: Method}>,
) => value;

const blocking = [
	request({
		type: "extension_ui_request",
		id: "select",
		method: "select",
		title: "Pick",
		options: ["A", "B"],
	}),
	request({
		type: "extension_ui_request",
		id: "confirm",
		method: "confirm",
		title: "Confirm",
		message: "Sure?",
	}),
	request({type: "extension_ui_request", id: "input", method: "input", title: "Input"}),
	request({type: "extension_ui_request", id: "editor", method: "editor", title: "Editor"}),
] as const;

const responseFor = (method: (typeof blocking)[number]["method"], id: string) =>
	method === "confirm"
		? ({type: "extension_ui_response", id, confirmed: false} as const)
		: ({type: "extension_ui_response", id, value: `${method}-value`} as const);

describe("RPC extension UI bridge", () => {
	it("pins every method from pi 0.84.3 to an explicit degradation policy", () => {
		assert.isTrue(exhaustiveRequestPin);
		assert.deepStrictEqual(Object.keys(extensionUIMethods), [
			"select",
			"confirm",
			"input",
			"editor",
			"notify",
			"setStatus",
			"setWidget",
			"setTitle",
			"set_editor_text",
		]);
		assert.strictEqual(extensionUIMethods.setTitle.support, "unavailable");
		assert.strictEqual(extensionUIMethods.set_editor_text.support, "deferred");
	});

	it.effect("refuses every blocking method when no browser is attached", () =>
		Effect.gen(function* () {
			const bridge = makeExtensionUI();
			for (const item of blocking) {
				const outcome = yield* bridge.dispatch(scope, item);
				assert.strictEqual(outcome._tag, "unavailable");
				assert.notStrictEqual(
					outcome._tag === "responded" && "confirmed" in outcome.response
						? outcome.response.confirmed
						: undefined,
					true,
				);
			}
		}),
	);

	it.effect(
		"correlates each blocking result exactly once and rejects mismatched or unknown responses",
		() =>
			Effect.gen(function* () {
				const bridge = makeExtensionUI();
				const events = yield* Queue.unbounded<ExtensionUIEvent>();
				const unsubscribe = yield* bridge.subscribe((event) => Queue.offerUnsafe(events, event));
				for (const item of blocking) {
					const fiber = yield* Effect.forkChild(bridge.dispatch(scope, item));
					const emitted = yield* Queue.take(events);
					assert.strictEqual(emitted._tag, "request");
					if (emitted._tag !== "request") continue;
					assert.strictEqual(emitted.request.id, item.id);

					const mismatch = yield* bridge.respond({
						scope,
						response:
							item.method === "confirm"
								? {type: "extension_ui_response", id: item.id, value: "wrong"}
								: {type: "extension_ui_response", id: item.id, confirmed: true},
					});
					assert.strictEqual(mismatch._tag, "method-mismatch");
					const response = responseFor(item.method, item.id);
					assert.strictEqual((yield* bridge.respond({scope, response}))._tag, "accepted");
					assert.strictEqual((yield* Fiber.join(fiber))._tag, "responded");
					assert.strictEqual((yield* bridge.respond({scope, response}))._tag, "duplicate");
					const settled = yield* Queue.take(events);
					assert.strictEqual(settled._tag, "settled");
				}
				assert.strictEqual(
					(yield* bridge.respond({
						scope,
						response: {type: "extension_ui_response", id: "never-seen", cancelled: true},
					}))._tag,
					"unknown",
				);
				unsubscribe();
			}),
	);

	it.effect("settles timeout, cancellation, disconnect, and unload once without replay", () => {
		let runTimeout = () => {};
		const scheduler: ExtensionUIScheduler = {
			schedule: (_milliseconds, run) => {
				runTimeout = run;
				return () => {};
			},
		};
		return Effect.gen(function* () {
			const bridge = makeExtensionUI(scheduler);
			const events = yield* Queue.unbounded<ExtensionUIEvent>();
			let unsubscribe = yield* bridge.subscribe((event) => Queue.offerUnsafe(events, event));

			const timed = yield* Effect.forkChild(
				bridge.dispatch(scope, {...blocking[0], id: "timed", timeout: 5}),
			);
			yield* Queue.take(events);
			runTimeout();
			assert.strictEqual((yield* Fiber.join(timed))._tag, "cancelled");
			yield* Queue.take(events);

			const cancelled = yield* Effect.forkChild(
				bridge.dispatch(scope, {...blocking[2], id: "cancelled"}),
			);
			yield* Queue.take(events);
			assert.strictEqual((yield* bridge.cancel({scope, id: "cancelled"}))._tag, "accepted");
			assert.strictEqual((yield* Fiber.join(cancelled))._tag, "cancelled");
			yield* Queue.take(events);

			const disconnected = yield* Effect.forkChild(
				bridge.dispatch(scope, {...blocking[3], id: "disconnected"}),
			);
			yield* Queue.take(events);
			unsubscribe();
			assert.strictEqual((yield* Fiber.join(disconnected))._tag, "cancelled");

			unsubscribe = yield* bridge.subscribe((event) => Queue.offerUnsafe(events, event));
			const unloaded = yield* Effect.forkChild(
				bridge.dispatch(scope, {...blocking[1], id: "unloaded"}),
			);
			yield* Queue.take(events);
			yield* bridge.unload(scope);
			assert.strictEqual((yield* Fiber.join(unloaded))._tag, "cancelled");
			assert.deepStrictEqual(yield* bridge.snapshots(), []);
			unsubscribe();
		});
	});

	it.effect(
		"publishes retained status/widget state only after its durable checkpoint succeeds",
		() =>
			Effect.gen(function* () {
				const raw = makeExtensionUI();
				const bridge = makeDurableExtensionUI(raw, () => Effect.succeed(false));
				const events: Array<ExtensionUIEvent> = [];
				const unsubscribe = yield* bridge.subscribe((event) => events.push(event));

				const status = yield* bridge.dispatch(
					scope,
					request({
						type: "extension_ui_request",
						id: "status-not-durable",
						method: "setStatus",
						statusKey: "build",
						statusText: "running",
					}),
				);
				const widget = yield* bridge.dispatch(
					scope,
					request({
						type: "extension_ui_request",
						id: "widget-not-durable",
						method: "setWidget",
						widgetKey: "plan",
						widgetLines: ["one"],
					}),
				);

				assert.strictEqual(status._tag, "unavailable");
				assert.strictEqual(widget._tag, "unavailable");
				assert.deepStrictEqual(events, []);
				assert.deepStrictEqual(yield* bridge.snapshots(), []);
				unsubscribe();
			}),
	);

	it.effect("refuses unload without cancelling or hiding state when persistence fails", () =>
		Effect.gen(function* () {
			const raw = makeExtensionUI();
			yield* raw.dispatch(
				scope,
				request({
					type: "extension_ui_request",
					id: "durable-status",
					method: "setStatus",
					statusKey: "build",
					statusText: "running",
				}),
			);
			const bridge = makeDurableExtensionUI(raw, () => Effect.succeed(false));
			const events: Array<ExtensionUIEvent> = [];
			const unsubscribe = yield* bridge.subscribe((event) => events.push(event));
			events.length = 0;

			const outcome = yield* bridge.unload(scope);

			assert.strictEqual(outcome._tag, "refused");
			assert.deepStrictEqual(events, []);
			assert.deepStrictEqual(yield* bridge.snapshots(), [
				{scope, statuses: [{key: "build", text: "running"}], widgets: []},
			]);
			unsubscribe();
		}),
	);

	it.effect("scopes ephemeral notification and replayable current status/widget state", () =>
		Effect.gen(function* () {
			const bridge = makeExtensionUI();
			const first = yield* Queue.unbounded<ExtensionUIEvent>();
			const unsubscribe = yield* bridge.subscribe((event) => Queue.offerUnsafe(first, event));
			const otherScope = {...scope, sessionId: "session-two"};

			yield* bridge.dispatch(
				scope,
				request({type: "extension_ui_request", id: "notify", method: "notify", message: "hello"}),
			);
			yield* bridge.dispatch(
				scope,
				request({
					type: "extension_ui_request",
					id: "status-1",
					method: "setStatus",
					statusKey: "build",
					statusText: "running",
				}),
			);
			yield* bridge.dispatch(
				scope,
				request({
					type: "extension_ui_request",
					id: "status-2",
					method: "setStatus",
					statusKey: "build",
					statusText: "done",
				}),
			);
			yield* bridge.dispatch(
				otherScope,
				request({
					type: "extension_ui_request",
					id: "widget",
					method: "setWidget",
					widgetKey: "plan",
					widgetLines: ["one"],
					widgetPlacement: "belowEditor",
				}),
			);
			assert.deepStrictEqual(yield* bridge.snapshots(), [
				{scope, statuses: [{key: "build", text: "done"}], widgets: []},
				{
					scope: otherScope,
					statuses: [],
					widgets: [{key: "plan", lines: ["one"], placement: "belowEditor"}],
				},
			]);
			unsubscribe();

			const replay = yield* Queue.unbounded<ExtensionUIEvent>();
			const unsubscribeReplay = yield* bridge.subscribe((event) =>
				Queue.offerUnsafe(replay, event),
			);
			const replayed = [yield* Queue.take(replay), yield* Queue.take(replay)];
			assert.deepStrictEqual(
				replayed.map((event) => [event._tag, "replay" in event && event.replay]),
				[
					["status", true],
					["widget", true],
				],
			);
			assert.isFalse(replayed.some((event) => event._tag === "notify" || event._tag === "request"));

			assert.strictEqual(
				(yield* bridge.dispatch(
					scope,
					request({
						type: "extension_ui_request",
						id: "title",
						method: "setTitle",
						title: "ignored",
					}),
				))._tag,
				"unavailable",
			);
			assert.strictEqual(
				(yield* bridge.dispatch(
					scope,
					request({
						type: "extension_ui_request",
						id: "editor-text",
						method: "set_editor_text",
						text: "later",
					}),
				))._tag,
				"deferred",
			);
			unsubscribeReplay();
		}),
	);
});
