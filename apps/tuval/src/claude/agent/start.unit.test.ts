/**
 * What `start` hands the SDK, what it hands back, and how it refuses.
 *
 * Every message the scripted `Query` replays is a golden fixture captured from a real run
 * (`../history/fixtures/PROVENANCE.md`): the `Options` object is ours to assert, but the frames the
 * layer folds are not something a test may invent.
 */

import type {ModelInfo} from "@anthropic-ai/claude-agent-sdk";
import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Logger, Option, Stream} from "effect";
import {Mode} from "../../ai-agent/ports/index.ts";
import {TUVAL_SERVER_NAME, wireNameOf} from "../tools/index.ts";
import {
	CWD,
	MODES,
	message,
	messages,
	OPENED_EVENTS,
	on,
	rows,
	SESSION_ID,
	START_EVENTS,
	TOOL_SESSION_ID,
} from "./fixtures/harness.ts";

/**
 * The info lines a run wrote. `start` reports the SDK pin beside the CLI version the init frame
 * named, and that pair is the only place SDK/CLI drift is visible, so it is asserted rather than
 * trusted (founder ruling on #7580).
 */
const logged = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<ReadonlyArray<string>, E> =>
	Effect.suspend(() => {
		const lines: Array<string> = [];
		const capture = Logger.layer([
			Logger.make(({logLevel, message}) => {
				if (logLevel !== "Info") return;
				lines.push(String(Array.isArray(message) ? message[0] : message));
			}),
		]);
		return effect.pipe(Effect.provide(capture), Effect.as(lines as ReadonlyArray<string>));
	});

const failure = (exit: Exit.Exit<unknown, unknown>): {_tag?: string; reason?: string} =>
	Exit.isFailure(exit)
		? ((Option.getOrUndefined(Cause.findErrorOption(exit.cause)) ?? {}) as {
				_tag?: string;
				reason?: string;
			})
		: {};

describe("start opens one streaming query", () => {
	it.effect("resolves the session id it opened the query under", () =>
		on({}, (agent) =>
			Effect.gen(function* () {
				const session = yield* agent.start({cwd: CWD});
				assert.strictEqual(session.sessionId, SESSION_ID);
			}),
		),
	);

	it.effect("hands the SDK the cwd, mode, tools, server, callback and env", () =>
		on({allowedTools: ["mcp__other__thing"], model: "claude-fable-5-1"}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const options = scripted.opened[0]?.record.options;
				assert.isDefined(options);
				assert.strictEqual(options?.cwd, CWD);
				assert.strictEqual(options?.permissionMode, "default");
				assert.strictEqual(options?.model, "claude-fable-5-1");
				assert.deepStrictEqual(options?.allowedTools, [
					wireNameOf("spawn"),
					wireNameOf("send"),
					wireNameOf("read"),
					"mcp__other__thing",
				]);
				assert.deepStrictEqual(Object.keys(options?.mcpServers ?? {}), [TUVAL_SERVER_NAME]);
				assert.isFunction(options?.canUseTool);
				assert.isString(options?.env?.USER);
				assert.notStrictEqual(options?.env?.USER, "");
				// SDK/CLI drift is accepted for this slice, so the executable is never pinned: the
				// CLI is the one the SDK bundles (founder ruling on #7580).
				assert.isUndefined(options?.pathToClaudeCodeExecutable);
				// A fresh session names no `resume`, so `continue` cannot be implied either.
				assert.isUndefined(options?.resume);
			}),
		),
	);

	it.effect("opens exactly one query for the whole session", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.prompt("first");
				yield* agent.prompt("second");
				assert.lengthOf(scripted.opened, 1);
			}),
		),
	);

	it.effect("logs the SDK pin beside the CLI version, once the init frame names one", () =>
		Effect.gen(function* () {
			const lines = yield* logged(
				on({version: "9.9.9-test", opening: [message("init")]}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						// The pair rides the `init` frame, which belongs to the first turn rather than to
						// the open, so the line lands only once the pump has read it.
						yield* Stream.runCollect(Stream.take(agent.events, OPENED_EVENTS));
					}),
				),
			);
			// `claude_code_version` off the captured `init` fixture, which is a real run's frame.
			const line = lines.find((each) => each.includes("SDK 9.9.9-test"));
			assert.isDefined(line);
			assert.include(line ?? "", "CLI 2.1.259");
			assert.include(line ?? "", SESSION_ID);
		}),
	);

	it.effect("emits starting, every list it offers, then the handshake's ready phase", () =>
		on({modes: MODES}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				assert.deepStrictEqual(yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS)), [
					{kind: "phase", phase: "starting"},
					// The opening mode, not the layer's raw held `null`: nothing has called `setMode`, so
					// what the query opened on is the row's own `permissionMode` (#7828).
					{kind: "mode", current: Mode.make("default"), available: MODES},
					{kind: "model", current: null, available: []},
					{kind: "commands", available: []},
					// A CLI offering no catalog offers no effort levels either: the set is a model's
					// (#8062), and there is no model here to read one off.
					{kind: "thinking", current: null, available: []},
					// Last, behind the catalogs it resolves — see `.patterns/agent-layer-phase-contract.md`
					// and the ordering case below (#8425).
					{kind: "phase", phase: "ready"},
				]);
			}),
		),
	);

	it.effect("announces the mode the query was opened on, not the layer's held null (#7828)", () =>
		on({permissionMode: Mode.make("plan"), modes: MODES}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				const announced = events.find((event) => event.kind === "mode");
				assert.deepStrictEqual(announced, {
					kind: "mode",
					current: Mode.make(scripted.opened[0]?.record.options.permissionMode ?? ""),
					available: MODES,
				});
			}),
		),
	);
});

describe("start against a CLI that says nothing until the first prompt", () => {
	// The defect this shape exists for (#7962): in streaming-input mode `init` is a turn's frame, the
	// machine refuses a prompt outside `ready`, and an open that waited for `init` was waiting for
	// the prompt only a ready session could send.
	const withheld = {opening: [message("init")], deferOpening: true} as const;

	it.effect("reaches ready with no prompt sent", () =>
		on(withheld, (agent, scripted) =>
			Effect.gen(function* () {
				const session = yield* agent.start({cwd: CWD});
				assert.strictEqual(session.sessionId, SESSION_ID);
				assert.lengthOf(scripted.opened[0]?.record.prompts ?? [], 0);
				assert.deepStrictEqual(yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS)), [
					{kind: "phase", phase: "starting"},
					{kind: "mode", current: Mode.make("default"), available: MODES},
					{kind: "model", current: null, available: []},
					{kind: "commands", available: []},
					{kind: "thinking", current: null, available: []},
					{kind: "phase", phase: "ready"},
				]);
			}),
		),
	);

	it.effect("opens the query under the id it hands back, which is the CLI's own", () =>
		on(withheld, (agent, scripted) =>
			Effect.gen(function* () {
				const session = yield* agent.start({cwd: CWD});
				assert.strictEqual(scripted.opened[0]?.record.options.sessionId, session.sessionId);
				// The two cannot ride one query (`sdk.d.ts`, `Options.sessionId`).
				assert.isUndefined(scripted.opened[0]?.record.options.resume);
			}),
		),
	);

	it.effect("records the session id and the CLI version once the init frame arrives", () =>
		Effect.gen(function* () {
			const lines = yield* logged(
				on(withheld, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
						yield* agent.prompt("hello");
						// The send's own `prompting` leads the turn (#8107); the init frame's model
						// line is the next thing out.
						assert.deepStrictEqual(yield* Stream.runCollect(Stream.take(agent.events, 2)), [
							{kind: "phase", phase: "prompting"},
							{
								kind: "usage",
								turn: "claude:model-announcement",
								model: "claude-fable-5-1",
								inputTokens: 0,
								outputTokens: 0,
								cost: 0,
							},
						]);
					}),
				),
			);
			const line = lines.find((each) => each.includes(SESSION_ID));
			assert.isDefined(line);
			assert.include(line ?? "", "CLI 2.1.259");
		}),
	);

	it.effect("fails the start when the query ends before its handshake comes back", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({...withheld, endsAtOnce: true}, (agent) => agent.start({cwd: CWD})),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/StartError");
			assert.strictEqual(failure(exit).reason, "transport");
		}),
	);
});

describe("start on a resume", () => {
	it.effect("passes the session id through and reads that session's store", () =>
		on({rows: rows()}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({
					cwd: CWD,
					resume: {sessionId: TOOL_SESSION_ID, holdsTranscript: false},
				});
				assert.deepStrictEqual(scripted.reads, [{sessionId: TOOL_SESSION_ID, dir: CWD}]);
				assert.strictEqual(scripted.opened[0]?.record.options.resume, TOOL_SESSION_ID);
			}),
		),
	);

	it.effect("refuses a session the store does not hold as SessionNotFound", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({}, (agent) =>
					agent.start({
						cwd: CWD,
						resume: {sessionId: "00000000-0000-4000-8000-00000000dead", holdsTranscript: false},
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/StartError");
			assert.strictEqual(failure(exit).reason, "session-not-found");
		}),
	);

	it.effect("takes the session down rather than leaving it on starting", () =>
		on({}, (agent) =>
			Effect.gen(function* () {
				yield* Effect.exit(
					agent.start({
						cwd: CWD,
						resume: {sessionId: "00000000-0000-4000-8000-00000000dead", holdsTranscript: false},
					}),
				);
				assert.deepStrictEqual(yield* Stream.runCollect(Stream.take(agent.events, 2)), [
					{kind: "phase", phase: "starting"},
					{kind: "phase", phase: "gone"},
				]);
			}),
		),
	);

	it.effect("resolves the cards it does not hold so a restored window drops them", () =>
		on(
			// The tool turn's first frames open a `tool_use` this scripted run never answers, so the
			// stored session carries exactly one call the layer cannot hold a card for.
			{rows: rows().slice(0, 2)},
			(agent) =>
				Effect.gen(function* () {
					yield* agent.start({
						cwd: CWD,
						resume: {sessionId: TOOL_SESSION_ID, holdsTranscript: false},
					});
					const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
					assert.deepStrictEqual(events[START_EVENTS], {
						kind: "permission-resolved",
						request: "toolu_00000000000000000010",
						decision: "deny",
					});
				}),
		),
	);

	it.effect("emits no resolution when every stored call already settled", () =>
		on({rows: rows(), opening: messages("tool-turn")}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({
					cwd: CWD,
					resume: {sessionId: TOOL_SESSION_ID, holdsTranscript: false},
				});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
				assert.notStrictEqual(events[START_EVENTS]?.kind, "permission-resolved");
			}),
		),
	);
});

describe("setModel", () => {
	const CATALOG = [
		{value: "opus", displayName: "Opus 5", description: "the deep one"},
		{value: "sonnet", displayName: "Sonnet 5", description: "the fast one"},
	];

	it.effect("announces the SDK's own catalog on the open", () =>
		on({models: CATALOG}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(
					events.find((event) => event.kind === "model"),
					{
						kind: "model",
						current: null,
						available: [
							{id: "opus", name: "Opus 5"},
							{id: "sonnet", name: "Sonnet 5"},
						],
					},
				);
			}),
		),
	);

	it.effect("reaches Query.setModel on the live session and announces the new state", () =>
		on({models: CATALOG}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setModel({id: "sonnet", name: "Sonnet 5"});
				// The live switch, not a respawn: one query was opened and it took the call.
				assert.lengthOf(scripted.opened, 1);
				assert.deepStrictEqual(scripted.opened[0]?.record.models, ["sonnet"]);
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
				assert.deepStrictEqual(events[START_EVENTS], {
					kind: "model",
					current: {id: "sonnet", name: "Sonnet 5"},
					available: [
						{id: "opus", name: "Opus 5"},
						{id: "sonnet", name: "Sonnet 5"},
					],
				});
			}),
		),
	);

	it.effect("keeps the announced model when the CLI refuses the switch", () =>
		on(
			{models: CATALOG, modelSwitchFails: new Error("the CLI would not switch")},
			(agent, scripted) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					// A refused switch is not `ModelUnsupported`, so this resolves rather than failing.
					yield* agent.setModel({id: "sonnet", name: "Sonnet 5"});
					assert.deepStrictEqual(
						scripted.opened[0]?.record.models,
						["sonnet"],
						"the switch was attempted; it is the announcement that must not move",
					);
					const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
					assert.deepStrictEqual(events[START_EVENTS], {
						kind: "model",
						current: null,
						available: [
							{id: "opus", name: "Opus 5"},
							{id: "sonnet", name: "Sonnet 5"},
						],
					});
				}),
		),
	);

	it.effect("opens on an empty catalog when the CLI cannot list its models", () =>
		on({catalogFails: new Error("supportedModels blew up")}, (agent) =>
			Effect.gen(function* () {
				// An absent picker is a session you can still prompt, so the open resolves.
				const session = yield* agent.start({cwd: CWD});
				assert.strictEqual(session.sessionId, SESSION_ID);
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(
					events.find((event) => event.kind === "model"),
					{
						kind: "model",
						current: null,
						available: [],
					},
				);
			}),
		),
	);

	it.effect("refuses a model the CLI's catalog does not offer", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({models: CATALOG}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						yield* agent.setModel({id: "gpt", name: "GPT"});
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/ModelUnsupported");
		}),
	);

	it.effect("holds a pick made before any session instead of refusing it", () =>
		on({models: CATALOG}, (agent) =>
			Effect.gen(function* () {
				// No session means no catalog, and "no session yet" is not "not offered" (#7981): the
				// pick is announced as current against the empty list rather than refused against it.
				yield* agent.setModel({id: "sonnet", name: "Sonnet 5"});
				const events = yield* Stream.runCollect(Stream.take(agent.events, 1));
				assert.deepStrictEqual(events[0], {
					kind: "model",
					current: {id: "sonnet", name: "Sonnet 5"},
					available: [],
				});
			}),
		),
	);

	it.effect("opens the first session on a pick made before it", () =>
		on({models: CATALOG}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.setModel({id: "sonnet", name: "Sonnet 5"});
				yield* agent.start({cwd: CWD});
				assert.deepStrictEqual(scripted.opened[0]?.record.models, ["sonnet"]);
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(
					events.find((event) => event.kind === "model"),
					{
						kind: "model",
						current: {id: "sonnet", name: "Sonnet 5"},
						available: [
							{id: "opus", name: "Opus 5"},
							{id: "sonnet", name: "Sonnet 5"},
						],
					},
				);
			}),
		),
	);

	it.effect("judges no pick against the catalog of a session that is gone", () =>
		on(
			{models: CATALOG, openFails: new Error("the CLI would not spawn"), openFailsAt: 2},
			(agent) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					const exit = yield* Effect.exit(agent.start({cwd: CWD}));
					assert.isTrue(Exit.isFailure(exit));
					// The first session's rows died with it, so a model none of them named is held for
					// the next open rather than refused against a list nothing offers any more.
					yield* agent.setModel({id: "gpt", name: "GPT"});
					// The failed open's own `starting` and `gone` come first on the fresh queue.
					const events = yield* Stream.runCollect(Stream.take(agent.events, 3));
					assert.deepStrictEqual(events[2], {
						kind: "model",
						current: {id: "gpt", name: "GPT"},
						available: [],
					});
				}),
		),
	);

	it.effect("opens a later session on the model it announced", () =>
		on({models: CATALOG}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setModel({id: "sonnet", name: "Sonnet 5"});
				yield* agent.start({cwd: CWD});
				// The query still opens on the row's static model — the SDK's `sessionId`/`resume`
				// options carry no model — so the switch is re-applied against the new session.
				assert.deepStrictEqual(scripted.opened[1]?.record.models, ["sonnet"]);
			}),
		),
	);
});

describe("commands", () => {
	const COMMANDS = [
		{name: "compact", description: "Summarise the conversation.", argumentHint: ""},
		{name: "skill:review", description: "Review it.", argumentHint: "<pr>"},
	];

	/** The SDK's mid-session push, exactly as `sdk.d.ts` declares `SDKCommandsChangedMessage`. */
	const changed = (commands: ReadonlyArray<Record<string, unknown>>) => ({
		type: "system" as const,
		subtype: "commands_changed" as const,
		commands,
		uuid: "00000000-0000-4000-8000-0000000000c1" as const,
		session_id: SESSION_ID,
	});

	it.effect("fills the catalog from supportedCommands at the open", () =>
		on({commands: COMMANDS}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				// The empty `argumentHint` the CLI sends for a command taking none is dropped rather
				// than carried as an empty string the picker would have to special-case.
				assert.deepStrictEqual(
					events.find((event) => event.kind === "commands"),
					{
						kind: "commands",
						available: [
							{name: "compact", description: "Summarise the conversation."},
							{name: "skill:review", description: "Review it.", argumentHint: "<pr>"},
						],
					},
				);
				assert.deepStrictEqual(yield* agent.commands, [
					{name: "compact", description: "Summarise the conversation."},
					{name: "skill:review", description: "Review it.", argumentHint: "<pr>"},
				]);
			}),
		),
	);

	it.effect("opens on an empty catalog when the CLI cannot list its commands", () =>
		on({commandsFail: new Error("supportedCommands blew up")}, (agent) =>
			Effect.gen(function* () {
				// An absent picker is a session you can still prompt, so the open resolves.
				const session = yield* agent.start({cwd: CWD});
				assert.strictEqual(session.sessionId, SESSION_ID);
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(
					events.find((event) => event.kind === "commands"),
					{kind: "commands", available: []},
				);
			}),
		),
	);

	it.effect("replaces the cached list on a commands_changed push rather than merging", () =>
		on({commands: COMMANDS}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				scripted.opened[0]?.say(
					changed([{name: "clear", description: "Clear it.", argumentHint: ""}]) as never,
				);
				const pushed = yield* Stream.runCollect(Stream.take(agent.events, 1));
				assert.deepStrictEqual(pushed[0], {
					kind: "commands",
					available: [{name: "clear", description: "Clear it."}],
				});
				// Replaced: neither command the open announced survives the push.
				assert.deepStrictEqual(yield* agent.commands, [{name: "clear", description: "Clear it."}]);
			}),
		),
	);
});

/**
 * The effort axis (#8062). Claude has five levels and neither `off` nor `minimal`, and the founder
 * ruled the picker shows exactly what the backend supports rather than mapping the missing two —
 * so the offered set is the model row's own `supportedEffortLevels` and a level outside it fails.
 */
describe("setThinkingLevel", () => {
	const EFFORT: ReadonlyArray<ModelInfo> = [
		{
			value: "opus",
			resolvedModel: "claude-opus-5",
			displayName: "Opus 5",
			description: "the deep one",
			supportsEffort: true,
			supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
		},
		{value: "haiku", displayName: "Haiku", description: "no effort axis"},
	];

	it.effect("discovers the running model without config or a first prompt (#8212)", () =>
		on(
			{
				models: [...EFFORT].reverse(),
				runningModel: "claude-opus-5",
				opening: [message("init")],
				deferOpening: true,
			},
			(agent, scripted) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
					assert.isUndefined(scripted.opened[0]?.record.options.model);
					assert.deepStrictEqual(scripted.opened[0]?.record.prompts, []);
					assert.deepStrictEqual(scripted.opened[0]?.record.contextReads, [{detail: "summary"}]);
					assert.deepStrictEqual(scripted.opened[0]?.record.models, []);
					assert.deepStrictEqual(events.find((event) => event.kind === "model")?.current, {
						id: "opus",
						name: "Opus 5",
					});
					assert.deepStrictEqual(
						events.find((event) => event.kind === "thinking"),
						{
							kind: "thinking",
							current: null,
							available: ["low", "medium", "high", "xhigh", "max"],
						},
					);
					yield* agent.setThinkingLevel("xhigh");
					assert.deepStrictEqual(scripted.opened[0]?.record.efforts, ["xhigh"]);
				}),
		),
	);

	it.effect("updates offered levels after setModel from a null-model start (#8212)", () =>
		on({models: EFFORT, runningModel: "unlisted-model"}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const opening = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.strictEqual(opening.find((event) => event.kind === "model")?.current, null);
				assert.deepStrictEqual(
					opening.find((event) => event.kind === "thinking"),
					{
						kind: "thinking",
						current: null,
						available: [],
					},
				);
				yield* agent.setModel({id: "opus", name: "Opus 5"});
				const changed = yield* Stream.runCollect(Stream.take(agent.events, 2));
				assert.deepStrictEqual(changed.at(-1), {
					kind: "thinking",
					current: null,
					available: ["low", "medium", "high", "xhigh", "max"],
				});
				assert.deepStrictEqual(scripted.opened[0]?.record.models, ["opus"]);
			}),
		),
	);

	it.effect("reads the runtime rather than assuming the configured model is active", () =>
		on({models: EFFORT, model: "haiku", runningModel: "claude-opus-5"}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(events.find((event) => event.kind === "thinking")?.available, [
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
				]);
			}),
		),
	);

	it.effect("does not turn a discovered default into an operator override on restart", () =>
		on({models: EFFORT, runningModel: "claude-opus-5"}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.start({cwd: CWD});
				assert.deepStrictEqual(scripted.opened[1]?.record.models, []);
				assert.deepStrictEqual(scripted.opened[1]?.record.contextReads, [{detail: "summary"}]);
				yield* agent.setModel({id: "haiku", name: "Haiku"});
				yield* agent.start({cwd: CWD});
				assert.deepStrictEqual(scripted.opened[2]?.record.models, ["haiku"]);
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(
					events.find((event) => event.kind === "thinking"),
					{
						kind: "thinking",
						current: null,
						available: [],
					},
				);
			}),
		),
	);

	it.effect("keeps start usable without guessing a default when discovery fails", () =>
		on({models: EFFORT, contextFails: new Error("context unavailable")}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(
					events.find((event) => event.kind === "thinking"),
					{
						kind: "thinking",
						current: null,
						available: [],
					},
				);
			}),
		),
	);

	it.effect("matches a configured canonical id when runtime discovery is unavailable", () =>
		on(
			{models: EFFORT, model: "claude-opus-5", contextFails: new Error("context unavailable")},
			(agent) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
					assert.deepStrictEqual(events.find((event) => event.kind === "model")?.current, {
						id: "opus",
						name: "Opus 5",
					});
				}),
		),
	);

	it.effect("announces the model row's own offered set on the open", () =>
		on({models: EFFORT, model: "opus"}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(
					events.find((event) => event.kind === "thinking"),
					{
						kind: "thinking",
						// Nothing has picked one, and the SDK publishes no current effort, so the layer
						// reports none rather than inventing the row's first level.
						current: null,
						available: ["low", "medium", "high", "xhigh", "max"],
					},
				);
			}),
		),
	);

	it.effect("reaches Query.applyFlagSettings on the live session and announces the level", () =>
		on({models: EFFORT, model: "opus"}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setThinkingLevel("xhigh");
				// The live switch, not a respawn: one query was opened and it took the call.
				assert.lengthOf(scripted.opened, 1);
				assert.deepStrictEqual(scripted.opened[0]?.record.efforts, ["xhigh"]);
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
				assert.deepStrictEqual(events[START_EVENTS], {
					kind: "thinking",
					current: "xhigh",
					available: ["low", "medium", "high", "xhigh", "max"],
				});
			}),
		),
	);

	it.effect("keeps the announced level when the CLI refuses the switch", () =>
		on(
			{
				models: EFFORT,
				model: "opus",
				effortSwitchFails: new Error("the CLI would not apply it"),
			},
			(agent, scripted) =>
				Effect.gen(function* () {
					yield* agent.start({cwd: CWD});
					yield* agent.setThinkingLevel("max");
					assert.deepStrictEqual(
						scripted.opened[0]?.record.efforts,
						["max"],
						"the switch was attempted; it is the announcement that must not move",
					);
					const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
					assert.deepStrictEqual(events[START_EVENTS], {
						kind: "thinking",
						current: null,
						available: ["low", "medium", "high", "xhigh", "max"],
					});
				}),
		),
	);

	it.effect("fails a level outside the offered set rather than dropping it", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({models: EFFORT, model: "opus"}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						// In the design vocabulary and outside Claude's effort axis, which is the whole
						// shape of the ruling.
						yield* agent.setThinkingLevel("minimal");
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/ThinkingUnsupported");
		}),
	);

	it.effect("offers nothing on a model whose row declares no effort levels", () =>
		on({models: EFFORT, model: "haiku"}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(
					events.find((event) => event.kind === "thinking"),
					{kind: "thinking", current: null, available: []},
				);
			}),
		),
	);

	it.effect("re-applies the level against a later session", () =>
		on({models: EFFORT, model: "opus"}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setThinkingLevel("high");
				yield* agent.start({cwd: CWD});
				// `applyFlagSettings` writes a session-scoped flag layer, so a new query opens without
				// it and the held pick has to be re-applied rather than merely re-announced.
				assert.deepStrictEqual(scripted.opened[1]?.record.efforts, ["high"]);
			}),
		),
	);

	it.effect("drops the level when a model switch takes it out of the offered set", () =>
		on({models: EFFORT, model: "opus"}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setThinkingLevel("max");
				yield* agent.setModel({id: "haiku", name: "Haiku"});
				// The offered set is the model's, so the switch moves the picker's rows — and a level
				// the new model would refuse stops being the current one.
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 3));
				assert.deepStrictEqual(events.at(-1), {
					kind: "thinking",
					current: null,
					available: [],
				});
			}),
		),
	);

	/**
	 * The ordering the composer's `offerResolved` rests on (#8425). `shell/chat/composer-bridge.ts`
	 * reads "the layer has said what this session offers" off the phase, because an empty offered
	 * set is otherwise indistinguishable from an unanswered one — so a `ready` ahead of these
	 * catalogs tells the picker the offer resolved empty for the length of four subprocess
	 * round-trips. The contract is `.patterns/agent-layer-phase-contract.md`.
	 */
	it.effect("closes the open on ready, behind every catalog it resolves (#8425)", () =>
		on({models: EFFORT, model: "opus", modes: MODES}, (agent) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				const kinds = (yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS))).map(
					(event) => event.kind,
				);
				assert.deepStrictEqual(kinds, ["phase", "mode", "model", "commands", "thinking", "phase"]);
			}),
		),
	);
});

describe("setMode", () => {
	it.effect("reaches Query.setPermissionMode and announces the new state", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setMode(Mode.make("plan"));
				assert.deepStrictEqual(scripted.opened[0]?.record.modes, ["plan"]);
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS + 1));
				assert.deepStrictEqual(events[START_EVENTS], {
					kind: "mode",
					current: Mode.make("plan"),
					available: MODES,
				});
			}),
		),
	);

	it.effect("opens a later session on the mode it announced, not the row's static one", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.start({cwd: CWD});
				yield* agent.setMode(Mode.make("plan"));
				yield* agent.start({cwd: CWD});
				assert.strictEqual(scripted.opened[1]?.record.options.permissionMode, "plan");
			}),
		),
	);

	it.effect("opens the first session on a mode set before it, which is permitted", () =>
		on({}, (agent, scripted) =>
			Effect.gen(function* () {
				yield* agent.setMode(Mode.make("plan"));
				yield* agent.start({cwd: CWD});
				assert.strictEqual(scripted.opened[0]?.record.options.permissionMode, "plan");
				const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
				assert.deepStrictEqual(
					events.find((event) => event.kind === "mode"),
					{
						kind: "mode",
						current: Mode.make("plan"),
						available: MODES,
					},
				);
			}),
		),
	);

	it.effect("refuses a mode the row does not advertise", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				on({}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						yield* agent.setMode(Mode.make("acceptWhatever"));
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/ModeUnsupported");
		}),
	);

	it.effect("never offers bypassPermissions or dontAsk, even when the row names them", () =>
		Effect.gen(function* () {
			const named = [Mode.make("default"), Mode.make("bypassPermissions"), Mode.make("dontAsk")];
			const exit = yield* Effect.exit(
				on({modes: named}, (agent) =>
					Effect.gen(function* () {
						yield* agent.start({cwd: CWD});
						const events = yield* Stream.runCollect(Stream.take(agent.events, START_EVENTS));
						assert.deepStrictEqual(
							events.find((event) => event.kind === "mode"),
							{
								kind: "mode",
								current: Mode.make("default"),
								available: [Mode.make("default")],
							},
						);
						yield* agent.setMode(Mode.make("bypassPermissions"));
					}),
				),
			);
			assert.strictEqual(failure(exit)._tag, "tuval/ai-agent/ModeUnsupported");
		}),
	);
});
