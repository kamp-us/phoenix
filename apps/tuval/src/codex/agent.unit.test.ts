import {describe, it} from "@effect/vitest";
import {Deferred, Effect, Exit, Fiber, Stream} from "effect";
import {expect} from "vitest";
import {foldEvent} from "../ai-agent/core/fold.ts";
import {initialState} from "../ai-agent/core/state.ts";
import {Mode} from "../ai-agent/ports/index.ts";
import {TransportError, type TuvalAiAgentApi} from "../ai-agent/service/index.ts";
import {
	fixtureTurns,
	itemMessage,
	modelRows,
	onCodex,
	opened,
	storedThread,
	thread,
	turn,
	turnMessage,
} from "./fixtures.ts";

const take = (agent: TuvalAiAgentApi, count: number) =>
	agent.events.pipe(Stream.take(count), Stream.runCollect);
const start = (agent: TuvalAiAgentApi) =>
	agent.start({cwd: thread.cwd}).pipe(Effect.andThen(take(agent, 6)));
const approval = {
	method: "item/commandExecution/requestApproval",
	id: 7,
	params: {
		threadId: thread.id,
		turnId: "turn-1",
		itemId: "shell-1",
		command: "rm example.txt",
		reason: "Delete the example",
	},
};

describe("Codex implements TuvalAiAgent", () => {
	it.effect.each([false, true])("folds an interrupt refusal after completion=%s", (completed) =>
		onCodex(
			(agent, fake) =>
				Effect.gen(function* () {
					const arrived = yield* Deferred.make<void>();
					const refuse = yield* Deferred.make<void>();
					fake.handlers.set("turn/interrupt", () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(arrived, undefined);
							yield* Deferred.await(refuse);
							return yield* new TransportError({reason: "refused", detail: "Cannot stop"});
						}),
					);
					const events = [...(yield* start(agent))];
					yield* agent.prompt("work");
					events.push(...(yield* take(agent, 1)));
					yield* fake.push(itemMessage("started", {type: "agentMessage", id: "a", text: "A"}));
					events.push(...(yield* take(agent, 1)));
					const interrupt = yield* Effect.forkChild(agent.interrupt);
					yield* Deferred.await(arrived);
					if (completed) {
						yield* fake.push(turnMessage("completed"));
						events.push(...(yield* take(agent, 2)));
					}
					yield* Deferred.succeed(refuse, undefined);
					yield* Fiber.join(interrupt);
					const failure = yield* take(agent, 1);
					expect(failure).toMatchObject([
						{
							kind: "failure",
							failure: {
								tag: "tuval/ai-agent/InterruptError",
								reason: completed ? "no-live-turn" : "turn-running",
								detail: expect.stringContaining("Cannot stop"),
							},
						},
					]);
					const state = [...events, ...failure].reduce(
						(state, event) => foldEvent(state, event, {itemLimit: 100}),
						initialState(thread.cwd),
					);
					expect(state.phase).toBe(completed ? "ready" : "prompting");
					expect(state.failure?.reason).toBe(completed ? "no-live-turn" : "turn-running");
					expect(state.transcript.items.at(-1)).toMatchObject({text: "A"});
					expect(state.transcript.items.at(-1)).toHaveProperty("kind", "assistant");
					if (!completed) {
						expect(state.transcript.items.at(-1)).toHaveProperty("partial", true);
						expect(yield* Effect.flip(agent.prompt("still busy"))).toMatchObject({
							reason: "refused",
						});
					} else {
						expect(state.transcript.items.at(-1)).not.toHaveProperty("partial");
						yield* agent.prompt("next turn");
					}
				}),
			{streamPartialReplies: true},
		),
	);
	it.effect("opens without a prompt and announces actual settings on the one stream", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				const events = yield* start(agent);
				expect(events.map((event) => event.kind)).toEqual([
					"phase",
					"mode",
					"model",
					"thinking",
					"commands",
					"phase",
				]);
				expect(events.at(-1)).toEqual({kind: "phase", phase: "ready"});
				expect(events[2]).toMatchObject({
					current: {id: "model-a"},
					available: modelRows.map((row) => ({id: row.model, name: row.displayName})),
				});
				expect(fake.calls.some((call) => call.method === "turn/start")).toBe(false);
				expect(fake.calls[0]).toMatchObject({
					method: "thread/start",
					params: {
						approvalPolicy: "on-request",
						approvalsReviewer: "user",
						sandbox: "workspace-write",
						config: {"mcp_servers.tuval": {required: true}},
					},
				});
			}),
		),
	);

	it.effect(
		"returns at turn acceptance, drops retry keys, and finishes only on turn/completed",
		() =>
			onCodex((agent, fake) =>
				Effect.gen(function* () {
					yield* start(agent);
					yield* agent.prompt("hello", "key-1");
					yield* agent.prompt("hello", "key-1");
					expect(fake.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
					expect(yield* take(agent, 1)).toEqual([{kind: "phase", phase: "prompting"}]);
					yield* fake.push(
						itemMessage("completed", {type: "agentMessage", id: "reply-1", text: "Hi"}),
					);
					yield* fake.push(turnMessage("completed"));
					expect(yield* take(agent, 2)).toMatchObject([
						{kind: "item", item: {kind: "assistant", text: "Hi"}},
						{kind: "phase", phase: "ready"},
					]);
					yield* agent.prompt("again", "key-2");
					expect(fake.calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
				}),
			),
	);

	it.effect(
		"does not resurrect a turn when completion arrives before its acceptance response",
		() =>
			onCodex((agent, fake) =>
				Effect.gen(function* () {
					yield* start(agent);
					fake.handlers.set("turn/start", () =>
						fake
							.push(turnMessage("completed"))
							.pipe(Effect.andThen(take(agent, 2)), Effect.as({turn: turn()})),
					);
					yield* agent.prompt("first", "first");
					yield* agent.prompt("second", "second");
					expect(fake.calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
				}),
			),
	);

	it.effect("streams partial replies under stable ids when enabled", () =>
		onCodex(
			(agent, fake) =>
				Effect.gen(function* () {
					yield* start(agent);
					yield* fake.push(itemMessage("started", {type: "agentMessage", id: "reply", text: ""}));
					yield* fake.push({
						method: "item/agentMessage/delta",
						params: {threadId: thread.id, turnId: "turn-1", itemId: "reply", delta: "hello"},
					});
					yield* fake.push(
						itemMessage("completed", {type: "agentMessage", id: "reply", text: "hello"}),
					);
					const events = yield* take(agent, 3);
					expect(events).toMatchObject([
						{item: {id: "reply", partial: true}},
						{item: {id: "reply", text: "hello", partial: true}},
						{item: {id: "reply", text: "hello"}},
					]);
					expect(events[2]).not.toHaveProperty("item.partial");
				}),
			{streamPartialReplies: true},
		),
	);

	it.effect("hides partial replies by default but emits the final reply", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				yield* start(agent);
				yield* fake.push(itemMessage("started", {type: "agentMessage", id: "reply", text: ""}));
				yield* fake.push({
					method: "item/agentMessage/delta",
					params: {threadId: thread.id, turnId: "turn-1", itemId: "reply", delta: "hello"},
				});
				yield* fake.push(
					itemMessage("completed", {type: "agentMessage", id: "reply", text: "hello"}),
				);
				yield* fake.push(turnMessage("completed"));
				expect(yield* take(agent, 2)).toMatchObject([
					{kind: "item", item: {text: "hello"}},
					{kind: "phase", phase: "ready"},
				]);
			}),
		),
	);

	it.effect("routes permission answers by RPC id and waits for server confirmation", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				yield* start(agent);
				yield* fake.push(approval);
				expect(yield* take(agent, 1)).toMatchObject([
					{kind: "permission", request: "shell-1", detail: {offersAlways: false}},
				]);
				yield* agent.answer("shell-1", "allow-once");
				expect(fake.replies).toEqual([{id: 7, result: {decision: "accept"}}]);
				expect(Exit.isFailure(yield* Effect.exit(agent.answer("shell-1", "allow-once")))).toBe(
					true,
				);
				yield* fake.push({
					method: "serverRequest/resolved",
					params: {threadId: thread.id, requestId: 7},
				});
				expect(yield* take(agent, 1)).toEqual([
					{kind: "permission-resolved", request: "shell-1", decision: "allow-once"},
				]);
			}),
		),
	);

	it.effect("denies rather than upgrading a forged allow-always answer", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				yield* start(agent);
				yield* fake.push(approval);
				yield* take(agent, 1);
				yield* agent.answer("shell-1", "allow-always");
				expect(fake.replies).toEqual([{id: 7, result: {decision: "decline"}}]);
			}),
		),
	);

	it.effect("rejects foreign-thread authority and unknown server requests", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				yield* start(agent);
				yield* fake.push({...approval, params: {...approval.params, threadId: "foreign"}});
				yield* fake.push({id: 8, method: "new/request", params: {threadId: thread.id}});
				expect(yield* take(agent, 1)).toMatchObject([
					{kind: "failure", failure: {tag: "CodexRequestUnsupported"}},
				]);
				expect(fake.rejected).toEqual([7, 8]);
			}),
		),
	);

	it.effect("interrupts the active turn and closes its unanswered cards", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				yield* start(agent);
				yield* agent.prompt("run");
				yield* take(agent, 1);
				yield* fake.push(approval);
				yield* take(agent, 1);
				yield* agent.interrupt;
				expect(fake.calls.at(-1)).toEqual({
					method: "turn/interrupt",
					params: {threadId: thread.id, turnId: "turn-1"},
				});
				expect(yield* take(agent, 2)).toEqual([
					{kind: "permission-resolved", request: "shell-1", decision: "deny"},
					{kind: "phase", phase: "ready"},
				]);
			}),
		),
	);

	it.effect("applies model, effort and mode through Codex's settings endpoint", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				yield* start(agent);
				yield* agent.setThinkingLevel("high");
				yield* take(agent, 3);
				yield* agent.setModel({id: "model-b", name: "ignored label"});
				expect(yield* take(agent, 3)).toMatchObject([
					{kind: "mode"},
					{kind: "model", current: {id: "model-b"}},
					{kind: "thinking", current: "low", available: ["low"]},
				]);
				yield* agent.setMode(Mode.make("read-only"));
				expect(fake.calls.at(-1)).toMatchObject({
					method: "thread/settings/update",
					params: {sandboxPolicy: {type: "readOnly"}, approvalPolicy: "on-request"},
				});
				expect(Exit.isFailure(yield* Effect.exit(agent.setThinkingLevel("max")))).toBe(true);
				expect(
					Exit.isFailure(yield* Effect.exit(agent.setMode(Mode.make("danger-full-access")))),
				).toBe(true);
				expect(
					Exit.isFailure(yield* Effect.exit(agent.setModel({id: "missing", name: "Missing"}))),
				).toBe(true);
			}),
		),
	);

	it.effect("keeps the current settings if Codex refuses a change", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				yield* start(agent);
				fake.handlers.set("thread/settings/update", () =>
					Effect.fail(new TransportError({reason: "refused", detail: "Not supported"})),
				);
				yield* agent.setMode(Mode.make("read-only"));
				expect(yield* take(agent, 3)).toMatchObject([
					{kind: "mode", current: "workspace-write"},
					{kind: "model", current: {id: "model-a"}},
					{kind: "thinking", current: "medium"},
				]);
			}),
		),
	);

	it.effect("lists sessions before start and closes the temporary connection", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				expect(yield* agent.listSessions).toEqual([
					{
						sessionId: thread.id,
						backend: "codex",
						lastModified: 2000,
						folder: thread.cwd,
						firstPrompt: "hello",
						branch: "main",
					},
				]);
				expect(fake.state).toEqual({opened: 1, closed: 1});
				expect(fake.calls).toHaveLength(2);
				expect(fake.calls[0]).toMatchObject({
					params: {
						modelProviders: [],
						sourceKinds: expect.arrayContaining(["cli", "appServer", "exec"]),
					},
				});
			}),
		),
	);

	it.effect("reads stored history without opening a session or attaching tools", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				fake.handlers.set("thread/read", () =>
					Effect.succeed({
						thread: {
							...thread,
							turns: [
								{
									...turn("completed"),
									items: [
										{type: "userMessage", id: "u", content: [{type: "text", text: "hello"}]},
										{type: "agentMessage", id: "a", text: "hi"},
									],
								},
							],
						},
					}),
				);
				const result = yield* agent.sessionTranscript({
					cwd: thread.cwd,
					sessionId: thread.id,
					before: null,
					limit: 1,
				});
				expect(result).toMatchObject({
					items: [
						{id: "u", text: "hello"},
						{id: "a", text: "hi"},
					],
					hasMore: false,
				});
				expect(fake.calls.map((call) => call.method)).toEqual([
					"thread/list",
					"thread/list",
					"thread/read",
				]);
				expect(fake.state).toEqual({opened: 1, closed: 1});
			}),
		),
	);

	it.effect("keeps missing, empty, unreadable and unknown-cursor histories distinct", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				const query = {cwd: thread.cwd, sessionId: thread.id, before: null, limit: 10};
				expect(yield* agent.sessionTranscript(query)).toEqual({items: [], hasMore: false});
				expect(
					yield* Effect.flip(agent.sessionTranscript({...query, sessionId: "missing"})),
				).toMatchObject({reason: "session-not-found"});
				expect(
					yield* Effect.flip(agent.sessionTranscript({...query, before: "missing"})),
				).toMatchObject({reason: "unknown-cursor"});
				fake.handlers.set("thread/read", () =>
					Effect.fail(new TransportError({reason: "refused", detail: "unreadable"})),
				);
				expect(yield* Effect.flip(agent.sessionTranscript(query))).toMatchObject({
					reason: "store-unreadable",
				});
				expect(fake.state.opened).toBe(fake.state.closed);
			}),
		),
	);

	it.effect.each([
		{shape: "default-selected paginated (001)", id: "session-1"},
		{shape: "explicit paginated (003)", id: "session-3"},
	])("refuses the unprojected $shape fixture rather than reporting it empty", ({id}) =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				storedThread(fake, {
					...thread,
					id,
					historyMode: "paginated",
					preview: "fixture user 1",
					turns: [],
				});
				const failure = yield* Effect.flip(
					agent.sessionTranscript({cwd: thread.cwd, sessionId: id, before: null, limit: 10}),
				);
				expect(failure).toMatchObject({
					reason: "store-unreadable",
					sessionId: id,
					detail: expect.stringContaining("cannot tell an empty session from history"),
				});
				expect(failure.detail).toContain("paginated");
				expect(fake.calls.map((call) => call.method)).toEqual([
					"thread/list",
					"thread/list",
					"thread/read",
				]);
				expect(fake.state).toEqual({opened: 1, closed: 1});
				expect(fake.replies).toEqual([]);
			}),
		),
	);

	it.effect.each([
		{mode: "paginated with a blank preview", patch: {historyMode: "paginated", preview: ""}},
		{mode: "no reported history mode", patch: {preview: "fixture user 1"}},
		{mode: "an unrecognized history mode", patch: {historyMode: "transcriptV2"}},
	])("cannot certify an empty history read under $mode", ({mode, patch}) =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				const {historyMode: _reported, ...modeless} = thread;
				storedThread(fake, {...modeless, ...patch, turns: []});
				expect(
					yield* Effect.flip(
						agent.sessionTranscript({
							cwd: thread.cwd,
							sessionId: thread.id,
							before: null,
							limit: 10,
						}),
					),
				).toMatchObject({
					reason: "store-unreadable",
					sessionId: thread.id,
					detail: expect.stringContaining(
						mode === "no reported history mode" ? "none reported" : "cannot tell",
					),
				});
				expect(fake.calls.some((call) => call.method === "thread/resume")).toBe(false);
				expect(fake.state).toEqual({opened: 1, closed: 1});
			}),
		),
	);

	it.effect("keeps the known-fresh active session's empty page, which reads no store", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				yield* start(agent);
				expect(yield* agent.page(null, 10)).toEqual({items: [], hasMore: false});
				expect(fake.calls.some((call) => call.method === "thread/read")).toBe(false);
				yield* fake.push(turnMessage("started"));
				yield* take(agent, 1);
				storedThread(fake, {...thread, historyMode: "paginated", turns: []});
				expect(yield* Effect.flip(agent.page(null, 10))).toMatchObject({
					reason: "store-unreadable",
					detail: expect.stringContaining("cannot tell an empty session from history"),
				});
				expect(fake.calls.some((call) => call.method === "turn/start")).toBe(false);
			}),
		),
	);

	it.effect("refuses an explicit resume whose stored paginated history reads empty", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				storedThread(fake, {...thread, historyMode: "paginated", turns: []});
				expect(
					yield* Effect.flip(
						agent.start({
							cwd: thread.cwd,
							resume: {sessionId: thread.id, holdsTranscript: false},
						}),
					),
				).toMatchObject({
					reason: "transport",
					detail: expect.stringContaining("cannot tell an empty session from history"),
				});
				expect(fake.calls.some((call) => call.method === "turn/start")).toBe(false);
			}),
		),
	);

	it.effect.each([
		{
			label: "legacy",
			mode: "legacy",
			ids: ["item-1", "item-2", "item-3", "item-4"] as const,
		},
		{
			label: "projected paginated",
			mode: "paginated",
			ids: ["user-1", "assistant-1", "user-2", "assistant-2"] as const,
		},
	])("reads the four $label fixture messages oldest first, a whole turn at a time", ({mode, ids}) =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				storedThread(fake, {...thread, historyMode: mode, turns: fixtureTurns(ids)});
				const query = {cwd: thread.cwd, sessionId: thread.id, before: null, limit: 1};
				const newest = yield* agent.sessionTranscript(query);
				expect(newest).toMatchObject({
					items: [
						{id: ids[2], text: "fixture user 2", timestamp: 4000},
						{id: ids[3], text: "fixture assistant 2", timestamp: 4000},
					],
					hasMore: true,
				});
				expect(yield* agent.sessionTranscript({...query, before: ids[2]})).toMatchObject({
					items: [
						{id: ids[0], text: "fixture user 1", timestamp: 3000},
						{id: ids[1], text: "fixture assistant 1", timestamp: 3000},
					],
					hasMore: false,
				});
				expect(yield* agent.sessionTranscript({...query, limit: 10})).toMatchObject({
					items: ids.map((id) => ({id})),
					hasMore: false,
				});
				expect(fake.calls.some((call) => call.method === "thread/resume")).toBe(false);
				expect(fake.state.opened).toBe(fake.state.closed);
			}),
		),
	);

	it.effect("keeps unsupported and malformed history reads distinct from an uncertain empty", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				const query = {cwd: thread.cwd, sessionId: thread.id, before: null, limit: 10};
				storedThread(fake, {...thread, turns: [{...turn("completed"), items: [{type: 23}]}]});
				expect(yield* Effect.flip(agent.sessionTranscript(query))).toMatchObject({
					reason: "store-unreadable",
					detail: expect.stringContaining("SchemaError"),
				});
				fake.handlers.set("thread/read", () =>
					Effect.fail(
						new TransportError({
							reason: "refused",
							detail: "thread/items/list is not supported yet",
						}),
					),
				);
				expect(yield* Effect.flip(agent.sessionTranscript(query))).toMatchObject({
					reason: "store-unreadable",
					detail: expect.stringContaining("not supported yet"),
				});
				expect(fake.state.opened).toBe(fake.state.closed);
			}),
		),
	);

	it.effect("publishes one complete usage report at the end of the turn", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				yield* start(agent);
				yield* fake.push(turnMessage("started"));
				yield* take(agent, 1);
				yield* fake.push({
					method: "thread/tokenUsage/updated",
					params: {
						threadId: thread.id,
						turnId: "turn-1",
						tokenUsage: {
							total: {inputTokens: 10, outputTokens: 2},
							last: {inputTokens: 10, outputTokens: 2},
						},
					},
				});
				yield* fake.push({
					method: "thread/tokenUsage/updated",
					params: {
						threadId: thread.id,
						turnId: "turn-1",
						tokenUsage: {
							total: {inputTokens: 30, outputTokens: 5},
							last: {inputTokens: 20, outputTokens: 3},
						},
					},
				});
				yield* fake.push(turnMessage("completed"));
				expect(yield* take(agent, 2)).toMatchObject([
					{kind: "usage", turn: "turn-1", inputTokens: 30, outputTokens: 5},
					{kind: "phase", phase: "ready"},
				]);
			}),
		),
	);

	it.effect("refuses a missing resume id instead of opening an empty session", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				const result = yield* Effect.exit(
					agent.start({cwd: thread.cwd, resume: {sessionId: "missing", holdsTranscript: false}}),
				);
				expect(Exit.isFailure(result)).toBe(true);
				expect(fake.calls.some((call) => call.method === "thread/resume")).toBe(false);
				expect(fake.state.closed).toBe(1);
				expect(yield* take(agent, 2)).toEqual([
					{kind: "phase", phase: "starting"},
					{kind: "phase", phase: "gone"},
				]);
			}),
		),
	);

	it.effect("resumes a stored session with the same tools, and pages the backend's history", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				fake.handlers.set("thread/read", () =>
					Effect.succeed({
						thread: {
							...thread,
							turns: [
								{
									...turn("completed"),
									startedAt: 3,
									items: [
										{type: "userMessage", id: "u", content: [{type: "text", text: "hello"}]},
										{type: "agentMessage", id: "a", text: "hi"},
									],
								},
							],
						},
					}),
				);
				yield* agent.start({
					cwd: thread.cwd,
					resume: {sessionId: thread.id, holdsTranscript: false},
				});
				expect((yield* take(agent, 10)).filter((event) => event.kind === "item")).toMatchObject([
					{kind: "item", item: {id: "u", text: "hello"}},
					{kind: "item", item: {id: "a", text: "hi"}},
				]);
				expect(fake.calls.find((call) => call.method === "thread/resume")).toMatchObject({
					params: {config: {"mcp_servers.tuval": {enabled: true, required: true}}},
				});
				expect(yield* agent.page(null, 1)).toMatchObject({
					items: [
						{id: "u", text: "hello", timestamp: 3000},
						{id: "a", text: "hi", timestamp: 3000},
					],
					hasMore: false,
				});
				expect(Exit.isFailure(yield* Effect.exit(agent.page("missing", 1)))).toBe(true);
			}),
		),
	);

	it.effect("closes the session and refuses new prompts after malformed known items", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				yield* start(agent);
				yield* fake.push(itemMessage("completed", {type: "agentMessage", id: "bad", text: 23}));
				expect(Exit.isFailure(yield* Effect.exit(take(agent, 1)))).toBe(true);
				expect(yield* Effect.flip(agent.prompt("do not send"))).toMatchObject({
					reason: "disconnected",
				});
				for (let attempt = 0; attempt < 100 && fake.state.closed === 0; attempt++)
					yield* Effect.yieldNow;
				expect(fake.state.closed).toBe(1);
				expect(fake.calls.some((call) => call.method === "turn/start")).toBe(false);
			}),
		),
	);

	it.effect(
		"queues approvals for the same stable item and does not resolve the next card early",
		() =>
			onCodex((agent, fake) =>
				Effect.gen(function* () {
					yield* start(agent);
					yield* fake.push(approval);
					yield* fake.push({...approval, id: "second"});
					yield* take(agent, 1);
					yield* agent.answer("shell-1", "deny");
					yield* fake.push({
						method: "serverRequest/resolved",
						params: {threadId: thread.id, requestId: 7},
					});
					expect(yield* take(agent, 2)).toMatchObject([
						{kind: "permission-resolved", request: "shell-1"},
						{kind: "permission", request: "shell-1"},
					]);
					yield* agent.answer("shell-1", "allow-once");
					expect(fake.replies).toEqual([
						{id: 7, result: {decision: "decline"}},
						{id: "second", result: {decision: "accept"}},
					]);
				}),
			),
	);

	it.effect("clears checkpointed cards by stable item id when it resumes", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				fake.handlers.set("thread/read", () =>
					Effect.succeed({
						thread: {
							...thread,
							turns: [
								{
									...turn("interrupted"),
									items: [
										{
											type: "commandExecution",
											id: "shell-1",
											command: "ls",
											cwd: thread.cwd,
											status: "failed",
											aggregatedOutput: "",
										},
									],
								},
							],
						},
					}),
				);
				yield* agent.start({
					cwd: thread.cwd,
					resume: {sessionId: thread.id, holdsTranscript: true, held: []},
				});
				expect(yield* take(agent, 8)).toContainEqual({
					kind: "permission-resolved",
					request: "shell-1",
					decision: "deny",
				});
			}),
		),
	);

	it.effect("offers ultra without renaming it when the selected model supports it", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				fake.handlers.set("model/list", () =>
					Effect.succeed({
						data: [{...modelRows[0], supportedReasoningEfforts: [{reasoningEffort: "ultra"}]}],
						nextCursor: null,
					}),
				);
				yield* start(agent);
				yield* agent.setThinkingLevel("ultra");
				expect(fake.calls.at(-1)).toMatchObject({
					method: "thread/settings/update",
					params: {effort: "ultra"},
				});
				expect(yield* take(agent, 3)).toContainEqual({
					kind: "thinking",
					current: "ultra",
					available: ["ultra"],
				});
			}),
		),
	);

	it.effect("does not accept a backend that ignored the requested sandbox", () =>
		onCodex((agent, fake) =>
			Effect.gen(function* () {
				fake.handlers.set("thread/start", () =>
					Effect.succeed({...opened, sandbox: {type: "dangerFullAccess"}}),
				);
				expect(Exit.isFailure(yield* Effect.exit(agent.start({cwd: thread.cwd})))).toBe(true);
				expect(fake.state.closed).toBe(1);
			}),
		),
	);
});
