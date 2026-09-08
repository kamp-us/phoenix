import {describe, it} from "@effect/vitest";
import {Deferred, Effect, Fiber, Stream} from "effect";
import {TestClock} from "effect/testing";
import {expect} from "vitest";
import {foldEvent} from "../ai-agent/core/fold.ts";
import {initialState} from "../ai-agent/core/state.ts";
import type {AgentEvent} from "../ai-agent/events.ts";
import {ItemId} from "../ai-agent/ports/index.ts";
import {TransportError, type TuvalAiAgentApi} from "../ai-agent/service/index.ts";
import {readChildTranscript} from "./child-store.ts";
import {fakeCodex, itemMessage, onCodex, thread, turn, turnMessage} from "./fixtures.ts";
import {NativeSubagents} from "./subagents.ts";

// Scripted projections of 0.153.4's generated ThreadItem/Thread types, not model captures.
const spawn = {
	type: "collabAgentToolCall",
	id: "spawn-1",
	tool: "spawnAgent",
	status: "completed",
	senderThreadId: thread.id,
	receiverThreadIds: ["child-1"],
	prompt: "Inspect the diff",
	agentsStates: {"child-1": {status: "running", message: null}},
};
const childThread = {
	...thread,
	id: "child-1",
	canAcceptDirectInput: false,
	agentRole: "reviewer",
	source: {subagent: {thread_spawn: {parent_thread_id: thread.id}}},
	status: {type: "active", activeFlags: []},
	turns: [
		{
			...turn(),
			items: [
				{type: "userMessage", id: "u", content: [{type: "text", text: "Inspect the diff"}]},
				{type: "agentMessage", id: "a", text: "Reading"},
			],
		},
	],
};
const take = (agent: TuvalAiAgentApi, count: number) =>
	agent.events.pipe(Stream.take(count), Stream.runCollect);
const start = (agent: TuvalAiAgentApi) =>
	agent.start({cwd: thread.cwd}).pipe(Effect.andThen(take(agent, 6)));
const slotOf = (events: ReadonlyArray<AgentEvent>) =>
	events.filter((event) => event.kind === "subagent").at(-1)?.slot;

describe("Codex native children on the shared protocol", () => {
	it("replaces slots by spawning call, not wait/send call, and child rows by stable identity", () => {
		const children = new NativeSubagents();
		children.collab(
			{...spawn, status: "inProgress", receiverThreadIds: [], agentsStates: {}},
			thread.id,
			10,
		);
		children.collab(spawn, thread.id, 20);
		children.item("child-1", {type: "agentMessage", id: "a", text: "A"}, 30, true);
		children.delta("child-1", "a", "B");
		children.item("child-1", {type: "agentMessage", id: "a", text: "AB"}, 40, false);
		children.usage("child-1", 23);
		children.usage("child-1", 10);
		children.collab(
			{
				...spawn,
				tool: "wait",
				id: "wait-1",
				agentsStates: {"child-1": {status: "completed", message: "AB"}},
			},
			thread.id,
			50,
		);
		expect([...children.slots.keys()]).toEqual(["spawn-1"]);
		expect(children.slots.get("spawn-1")).toMatchObject({
			startedAt: 10,
			tokens: 23,
			status: "finished",
			lastLine: "AB",
			items: [{id: "spawn-1/a", parentId: "spawn-1", text: "AB", timestamp: 30}],
		});
		expect(children.slots.get("spawn-1")?.items).toHaveLength(1);
	});

	it.each([
		"interrupted",
		"completed",
		"errored",
		"shutdown",
		"notFound",
	])("retains terminal %s slots for the generic navigator", (status) => {
		const children = new NativeSubagents();
		const events = children.collab(spawn, thread.id, 10);
		const item = children.item(
			"child-1",
			{type: "agentMessage", id: "a", text: "Child answer"},
			20,
			false,
		);
		const terminal = children.collab(
			{
				...spawn,
				id: "wait-1",
				tool: "wait",
				agentsStates: {"child-1": {status, message: "Child answer"}},
			},
			thread.id,
			30,
		);
		const state = [...events, ...(item === null ? [] : [item]), ...terminal].reduce(
			(state, event) => foldEvent(state, event, {itemLimit: 100}),
			initialState(thread.cwd),
		);
		expect(state.subagents["spawn-1"]?.status).toBe("finished");
		expect(state.subagents["spawn-1"]?.items).toMatchObject([{text: "Child answer"}]);
		expect(state.transcript.items).toEqual([]);
	});

	it("keeps child items isolated, restores authoritative order and finalizes partial/tool rows", () => {
		const children = new NativeSubagents();
		children.collab(spawn, thread.id, 10);
		children.collab(
			{...spawn, id: "spawn-2", receiverThreadIds: ["child-2"], agentsStates: {}},
			thread.id,
			20,
		);
		children.item("child-1", {type: "agentMessage", id: "same", text: "one"}, 30, true);
		children.item("child-2", {type: "agentMessage", id: "same", text: "two"}, 30, true);
		children.item(
			"child-1",
			{
				type: "commandExecution",
				id: "tool",
				command: "ls",
				cwd: "/tmp",
				status: "inProgress",
				aggregatedOutput: null,
			},
			40,
			false,
		);
		children.finish("Interrupted");
		expect(children.slots.get("spawn-1")?.items).toMatchObject([
			{id: "spawn-1/same", text: "one", interrupted: true},
			{status: "error"},
		]);
		expect(children.slots.get("spawn-2")?.items).toMatchObject([{id: "spawn-2/same", text: "two"}]);
		children.hydrate("child-1", {
			type: "reviewer",
			status: "finished",
			turnId: null,
			items: [
				{kind: "user", id: ItemId.make("u"), timestamp: 1, text: "prompt"},
				{kind: "assistant", id: ItemId.make("same"), timestamp: 2, text: "settled"},
			],
		});
		expect(children.slots.get("spawn-1")?.items).toMatchObject([
			{id: "spawn-1/u"},
			{id: "spawn-1/same", timestamp: 30, text: "settled"},
		]);
	});

	it("gives completed payloads precedence over polls and never reopens them with queued starts/deltas", () => {
		const children = new NativeSubagents();
		children.collab(spawn, thread.id, 10);
		const snapshot = {
			type: "reviewer",
			status: "running" as const,
			turnId: "turn-1",
			items: [
				{
					kind: "assistant" as const,
					id: ItemId.make("a"),
					timestamp: 20,
					text: "ABC",
					partial: true as const,
				},
			],
		};
		children.hydrate("child-1", snapshot);
		expect(children.delta("child-1", "a", "B")).toBeNull();
		expect(
			children.item("child-1", {type: "agentMessage", id: "a", text: "A"}, 30, true),
		).toBeNull();
		children.item("child-1", {type: "agentMessage", id: "a", text: "ABC final"}, 40, false);
		children.hydrate("child-1", snapshot);
		expect(children.delta("child-1", "a", "C")).toBeNull();
		expect(children.needsSnapshot("child-1", "a")).toBe(false);
		children.finishCall("spawn-1", "completed", false);
		expect(children.slots.get("spawn-1")?.items).toMatchObject([
			{text: "ABC final", timestamp: 20},
		]);
		expect(children.slots.get("spawn-1")?.items[0]).not.toHaveProperty("partial");
	});

	it("detaches already finished and pending-spawn slots and rejects late hydration", () => {
		const children = new NativeSubagents();
		children.collab(spawn, thread.id, 10);
		children.item("child-1", {type: "agentMessage", id: "a", text: "Retained"}, 20, false);
		children.finishCall("spawn-1", "completed", false);
		children.collab(
			{...spawn, id: "pending", status: "inProgress", receiverThreadIds: [], agentsStates: {}},
			thread.id,
			30,
		);
		children.stopObserving("Parent interrupted");
		const retained = children.slots.get("spawn-1");
		expect(children.observes("child-1")).toBe(false);
		expect(
			children.hydrate("child-1", {
				type: "reviewer",
				status: "running",
				turnId: "late-turn",
				items: [],
			}),
		).toBeNull();
		expect(children.status("child-1", "running")).toBeNull();
		expect(children.collab(spawn, thread.id, 40)).toEqual([]);
		expect(children.collab({...spawn, id: "pending"}, thread.id, 40)).toEqual([]);
		expect(children.slots.get("spawn-1")).toEqual(retained);
		expect(children.slots.get("pending")?.status).toBe("finished");
		children.interruptRefused("child-1", "Cannot stop");
		expect(children.slots.get("spawn-1")).toEqual({
			...retained,
			lastLine: "Interrupt refused: Cannot stop",
		});
		expect(children.observes("child-1")).toBe(false);
	});

	it("refuses foreign senders and ambiguous spawns, and makes uncorrelated updates visible", () => {
		const children = new NativeSubagents();
		expect(() => children.collab({...spawn, senderThreadId: "foreign"}, thread.id, 0)).toThrow(
			"foreign sender",
		);
		expect(() =>
			children.collab({...spawn, receiverThreadIds: ["one", "two"]}, thread.id, 0),
		).toThrow("multiple children");
		expect(children.collab({...spawn, tool: "wait"}, thread.id, 0)).toMatchObject([
			{kind: "item", item: {kind: "system", text: expect.stringContaining("Unsupported")}},
		]);
	});

	it.effect(
		"integrates collab, correlated child notifications, usage and completed navigation",
		() =>
			onCodex((agent, fake) =>
				Effect.gen(function* () {
					fake.handlers.set("thread/read", () => Effect.succeed({thread: childThread}));
					yield* start(agent);
					yield* fake.push(itemMessage("completed", spawn));
					const initial = yield* take(agent, 3);
					expect(slotOf(initial)).toMatchObject({
						id: "spawn-1",
						type: "reviewer",
						items: [{id: "spawn-1/u"}, {id: "spawn-1/a"}],
					});
					yield* fake.push({
						method: "item/completed",
						params: {
							threadId: "child-1",
							turnId: "turn-1",
							item: {type: "agentMessage", id: "a", text: "Done"},
						},
					});
					yield* fake.push({
						method: "thread/tokenUsage/updated",
						params: {
							threadId: "child-1",
							turnId: "turn-1",
							tokenUsage: {
								total: {inputTokens: 10, outputTokens: 3},
								last: {inputTokens: 10, outputTokens: 3},
							},
						},
					});
					yield* fake.push({
						method: "turn/completed",
						params: {threadId: "child-1", turn: turn("completed")},
					});
					const done = yield* take(agent, 4);
					expect(slotOf(done)).toMatchObject({
						status: "finished",
						tokens: 13,
						items: [{id: "spawn-1/u"}, {id: "spawn-1/a", text: "Done"}],
					});
					expect(done.every((event) => event.kind === "subagent")).toBe(true);
					expect(fake.calls.some((call) => call.method === "thread/resume")).toBe(false);
				}),
			),
	);

	it.effect(
		"interrupts observed child turns as well as the parent, retaining the child transcript",
		() =>
			onCodex((agent, fake) =>
				Effect.gen(function* () {
					fake.handlers.set("thread/read", () => Effect.succeed({thread: childThread}));
					fake.handlers.set("turn/interrupt", () => Effect.succeed({}));
					yield* start(agent);
					yield* agent.prompt("work");
					yield* take(agent, 1);
					yield* fake.push(itemMessage("completed", spawn));
					yield* take(agent, 3);
					yield* agent.interrupt;
					expect(fake.calls.filter((call) => call.method === "turn/interrupt")).toMatchObject([
						{params: {threadId: "child-1", turnId: "turn-1"}},
						{params: {threadId: thread.id, turnId: "turn-1"}},
					]);
					yield* fake.push(turnMessage("completed", "interrupted"));
					expect(slotOf(yield* take(agent, 3))).toMatchObject({
						status: "finished",
						items: [{id: "spawn-1/u"}, {id: "spawn-1/a"}],
					});
				}),
			),
	);

	it.effect("shows a child read refusal rather than empty success or a phantom running slot", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				fake.handlers.set("thread/read", () =>
					Effect.fail(
						new TransportError({reason: "refused", detail: "thread/read is not supported yet"}),
					),
				);
				yield* start(agent);
				yield* fake.push(itemMessage("completed", spawn));
				expect(slotOf(yield* take(agent, 4))).toMatchObject({
					status: "finished",
					lastLine: expect.stringContaining("unsupported"),
					items: [{kind: "system", text: expect.stringContaining("unsupported")}],
				});
			}),
		),
	);

	it.effect("rebuilds stored child slots on checkpoint resume without resuming a child", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				fake.handlers.set("thread/read", (params) => {
					const id =
						typeof params === "object" && params !== null && "threadId" in params
							? params.threadId
							: null;
					return Effect.succeed({
						thread:
							id === "child-1"
								? {
										...childThread,
										status: {type: "notLoaded"},
										turns: [{...turn("completed"), items: childThread.turns[0]?.items ?? []}],
									}
								: {...thread, turns: [{...turn("completed"), items: [spawn]}]},
					});
				});
				yield* agent.start({
					cwd: thread.cwd,
					resume: {sessionId: thread.id, holdsTranscript: true, held: []},
				});
				const events = yield* take(agent, 11);
				expect(slotOf(events)).toMatchObject({
					id: "spawn-1",
					status: "finished",
					startedAt: 1000,
					items: [{id: "spawn-1/u"}, {id: "spawn-1/a"}],
				});
				expect(fake.calls.filter((call) => call.method === "thread/resume")).toMatchObject([
					{params: {threadId: thread.id}},
				]);
			}),
		),
	);
});

describe("Codex child polling and failure cleanup", () => {
	it.effect.each([
		"running",
		"child-completed",
		"child-interrupted",
		"parent-completed",
		"parent-interrupted",
		"parent-failed",
		"parent-error",
	])("preserves arrival-time child state on delayed interrupt refusal after %s", (outcome) =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				const arrived = yield* Deferred.make<void>();
				const refuse = yield* Deferred.make<void>();
				fake.handlers.set("thread/read", () => Effect.succeed({thread: childThread}));
				fake.handlers.set("turn/interrupt", (params) =>
					Effect.gen(function* () {
						if ((params as {threadId: string}).threadId !== "child-1") return {};
						yield* Deferred.succeed(arrived, undefined);
						yield* Deferred.await(refuse);
						return yield* new TransportError({reason: "refused", detail: "Cannot stop child"});
					}),
				);
				const events = [...(yield* start(agent))];
				yield* agent.prompt("work");
				events.push(...(yield* take(agent, 1)));
				yield* fake.push(itemMessage("completed", spawn));
				events.push(...(yield* take(agent, 3)));
				const interrupt = yield* Effect.forkChild(agent.interrupt);
				yield* Deferred.await(arrived);
				const detached = ["parent-interrupted", "parent-failed", "parent-error"].includes(outcome);
				const finished = detached || outcome.startsWith("child-");
				if (outcome.startsWith("child-")) {
					yield* fake.push({
						method: "turn/completed",
						params: {threadId: "child-1", turn: turn(outcome.slice(6))},
					});
					events.push(...(yield* take(agent, 2)));
				} else if (outcome === "parent-error") {
					yield* fake.push({
						method: "error",
						params: {threadId: thread.id, error: {message: "Stopped"}, willRetry: false},
					});
					events.push(...(yield* take(agent, 2)));
				} else if (outcome.startsWith("parent-")) {
					yield* fake.push(turnMessage("completed", outcome.slice(7)));
					events.push(...(yield* take(agent, 3)));
				}
				const retained = slotOf(events);
				yield* Deferred.succeed(refuse, undefined);
				yield* Fiber.join(interrupt);
				const refusal = yield* take(agent, 1);
				expect(slotOf(refusal)).toEqual({
					...retained,
					lastLine: "Interrupt refused: Cannot stop child",
				});
				events.push(...refusal);
				const reads = fake.calls.filter((call) => call.method === "thread/read").length;
				if (detached) {
					for (const method of ["turn/started", "turn/completed"]) {
						yield* fake.push({
							method,
							params: {threadId: "child-1", turn: turn()},
						});
					}
					yield* fake.push({
						method: "item/completed",
						params: {
							threadId: "child-1",
							turnId: "turn-1",
							item: {type: "agentMessage", id: "a", text: "Late content"},
						},
					});
					yield* fake.push(
						itemMessage("completed", {
							type: "subAgentActivity",
							id: "activity",
							kind: "started",
							agentThreadId: "child-1",
						}),
					);
					yield* fake.push(itemMessage("completed", {...spawn, id: "wait-late", tool: "wait"}));
				}
				yield* TestClock.adjust("3 seconds");
				yield* fake.push(
					itemMessage("completed", {type: "agentMessage", id: "barrier", text: "Parent"}),
				);
				const later = yield* agent.events.pipe(
					Stream.takeUntil((event) => event.kind === "item" && event.item.id === "barrier"),
					Stream.runCollect,
				);
				if (finished) {
					expect(later.filter((event) => event.kind === "subagent")).toEqual([]);
					expect(fake.calls.filter((call) => call.method === "thread/read")).toHaveLength(reads);
				} else {
					expect(fake.calls.filter((call) => call.method === "thread/read").length).toBeGreaterThan(
						reads,
					);
				}
				const state = [...events, ...later].reduce(
					(state, event) => foldEvent(state, event, {itemLimit: 100}),
					initialState(thread.cwd),
				);
				expect(state.subagents["spawn-1"]).toMatchObject({
					status: finished ? "finished" : "running",
					items: [{id: "spawn-1/u"}, {id: "spawn-1/a", text: "Reading"}],
				});
				if (finished) expect(state.subagents["spawn-1"]).toEqual(slotOf(refusal));
				expect(fake.calls.some((call) => call.method === "thread/resume")).toBe(false);
			}),
		),
	);

	it.effect.each(["completed", "interrupted"])(
		"reconciles queued deltas, snapshot-only rows and terminal %s through the adapter",
		(terminal) =>
			onCodex((agent, fake) =>
				Effect.gen(function* () {
					let text = "ABC";
					let snapshotOnly = "XYZ";
					const arrived = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					let reading = false;
					fake.handlers.set("thread/read", () =>
						Effect.gen(function* () {
							if (!reading) return {thread: {...childThread, turns: []}};
							yield* Deferred.succeed(arrived, undefined);
							yield* Deferred.await(release);
							return {
								thread: {
									...childThread,
									turns: [
										{
											...turn(),
											items: [
												{type: "agentMessage", id: "a", text},
												{type: "agentMessage", id: "b", text: snapshotOnly},
											],
										},
									],
								},
							};
						}),
					);
					yield* start(agent);
					yield* fake.push(itemMessage("completed", spawn));
					const events = [...(yield* take(agent, 3))];
					yield* fake.push({
						method: "item/started",
						params: {
							threadId: "child-1",
							turnId: "turn-1",
							item: {type: "agentMessage", id: "a", text: "A"},
						},
					});
					events.push(...(yield* take(agent, 1)));
					reading = true;
					yield* TestClock.adjust("1 second");
					yield* Deferred.await(arrived);
					for (const [itemId, delta] of [
						["a", "B"],
						["a", "C"],
						["b", "YZ"],
					]) {
						yield* fake.push({
							method: "item/agentMessage/delta",
							params: {
								threadId: "child-1",
								turnId: "turn-1",
								itemId,
								delta,
							},
						});
					}
					yield* Deferred.succeed(release, undefined);
					const overlap = yield* take(agent, 4);
					for (const event of overlap)
						expect(slotOf([event])?.items).toMatchObject([{text: "ABC"}, {text: "XYZ"}]);
					events.push(...overlap);
					snapshotOnly = "XYZ!";
					yield* fake.push({
						method: "item/agentMessage/delta",
						params: {
							threadId: "child-1",
							turnId: "turn-1",
							itemId: "b",
							delta: "!",
						},
					});
					const progress = yield* take(agent, 1);
					expect(slotOf(progress)?.items).toMatchObject([{text: "ABC"}, {text: "XYZ!"}]);
					events.push(...progress);
					text = "ABC final";
					yield* fake.push({
						method: "turn/completed",
						params: {
							threadId: "child-1",
							turn: turn(terminal),
						},
					});
					events.push(...(yield* take(agent, 2)));
					const state = events.reduce(
						(state, event) => foldEvent(state, event, {itemLimit: 100}),
						initialState(thread.cwd),
					);
					expect(state.transcript.items).toMatchObject([{id: "spawn-1", kind: "tool"}]);
					expect(state.subagents["spawn-1"]).toMatchObject({
						status: "finished",
						items: [
							{id: "spawn-1/a", text: "ABC final", timestamp: 0},
							{id: "spawn-1/b", text: "XYZ!"},
						],
					});
					for (const item of state.subagents["spawn-1"]?.items ?? []) {
						expect(item).not.toHaveProperty("partial");
						if (terminal === "interrupted") expect(item).toHaveProperty("interrupted", true);
						else expect(item).not.toHaveProperty("interrupted");
					}
					expect(fake.calls.filter((call) => call.method === "thread/resume")).toEqual([]);
				}),
			),
	);

	it.effect("keeps an unmaterialized refusal visible and retries until history exists", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				fake.handlers.set("thread/read", () =>
					Effect.fail(
						new TransportError({
							reason: "refused",
							detail:
								"thread child-1 is not materialized yet; includeTurns is unavailable before first user message",
						}),
					),
				);
				yield* start(agent);
				yield* fake.push(itemMessage("completed", spawn));
				expect(slotOf(yield* take(agent, 3))).toMatchObject({
					status: "running",
					items: [{text: expect.stringContaining("not materialized")}],
				});
				fake.handlers.set("thread/read", () => Effect.succeed({thread: childThread}));
				yield* TestClock.adjust("1 second");
				const slot = slotOf(yield* take(agent, 1));
				expect(slot?.items).toMatchObject([{id: "spawn-1/u"}, {id: "spawn-1/a"}]);
				expect(slot?.items.some((item) => item.id.endsWith("history-error"))).toBe(false);
			}),
		),
	);

	it.effect("polls read-only progress and keeps a background child after parent completion", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				let text = "Reading";
				fake.handlers.set("thread/read", () =>
					Effect.succeed({
						thread: {
							...childThread,
							turns: [{...turn(), items: [{type: "agentMessage", id: "a", text}]}],
						},
					}),
				);
				yield* start(agent);
				yield* fake.push(itemMessage("completed", spawn));
				yield* take(agent, 3);
				text = "Progress";
				yield* TestClock.adjust("1 second");
				expect(slotOf(yield* take(agent, 1))).toMatchObject({
					lastLine: "Progress",
					status: "running",
				});
				yield* fake.push(turnMessage("completed"));
				const events = yield* take(agent, 3);
				const state = events.reduce(
					(state, event) => foldEvent(state, event, {itemLimit: 100}),
					initialState(thread.cwd),
				);
				expect(state.subagents["spawn-1"]?.status).toBe("running");
				expect(fake.calls.filter((call) => call.method === "thread/resume")).toEqual([]);
			}),
		),
	);
	it.effect("finishes children before an unrecoverable parent error", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				fake.handlers.set("thread/read", () => Effect.succeed({thread: childThread}));
				yield* start(agent);
				yield* fake.push(itemMessage("completed", spawn));
				yield* take(agent, 3);
				yield* fake.push({
					method: "error",
					params: {threadId: thread.id, error: {message: "Stopped"}, willRetry: false},
				});
				expect(yield* take(agent, 2)).toMatchObject([
					{kind: "subagent", slot: {status: "finished", lastLine: "Stopped"}},
					{kind: "failure"},
				]);
			}),
		),
	);
});

describe("Codex read-only child store", () => {
	it.effect("accepts a genuinely empty supported history without starting or resuming", () =>
		Effect.gen(function* () {
			const fake = yield* fakeCodex;
			fake.handlers.set("thread/read", () =>
				Effect.succeed({thread: {...childThread, turns: [], status: {type: "notLoaded"}}}),
			);
			expect(yield* readChildTranscript(fake.connection, thread.id, "child-1")).toEqual({
				items: [],
				type: "reviewer",
				status: "finished",
				turnId: null,
			});
			expect(fake.calls.map((call) => call.method)).toEqual(["thread/read"]);
		}),
	);
	it.effect("distinguishes unsupported, missing, unreadable and malformed from empty", () =>
		Effect.gen(function* () {
			const fake = yield* fakeCodex;
			for (const [detail, reason] of [
				["thread/read is not supported yet", "unsupported"],
				["ephemeral threads do not support includeTurns", "unsupported"],
				["thread not loaded: child-1", "missing"],
				["failed to read thread: permission denied", "unreadable"],
			] as const) {
				fake.handlers.set("thread/read", () =>
					Effect.fail(new TransportError({reason: "refused", detail})),
				);
				expect(
					yield* Effect.flip(readChildTranscript(fake.connection, thread.id, "child-1")),
				).toMatchObject({reason});
			}
			for (const value of [
				null,
				{...childThread, id: "other"},
				{...childThread, source: "cli"},
				{...childThread, turns: [{...turn(), items: [{type: "agentMessage", id: "a", text: 3}]}]},
			]) {
				fake.handlers.set("thread/read", () => Effect.succeed({thread: value}));
				expect(
					yield* Effect.flip(readChildTranscript(fake.connection, thread.id, "child-1")),
				).toMatchObject({reason: "malformed"});
			}
		}),
	);
});
