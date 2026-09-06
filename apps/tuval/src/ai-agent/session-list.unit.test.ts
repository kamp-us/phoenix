/**
 * The session-list spell as a caller reaches it: through the real executor, addressed at the path
 * the program row registers it under, answered as a `SpellReply` and nothing else.
 *
 * The three facts every test here holds are the three a blank window would hide. One list, in one
 * order, whatever registered it. A store that could not be read is named beside the rows that were,
 * never in place of them. And the walk is bounded, so an unreachable store is a refusal the caller
 * reads rather than a call it waits on forever.
 */

import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Layer} from "effect";
import {TestClock} from "effect/testing";
import {SpellExecutor} from "../commands/executor.ts";
import {type Client, WindowIndex} from "../commands/scope.ts";
import {ClientId, WorkspaceId} from "../commands/spell.ts";
import {SpellSet} from "../commands/spell-set.ts";
import {CallId} from "../protocol/ids.ts";
import {PROTOCOL_VERSION, SpellCall, type SpellReply} from "../protocol/messages.ts";
import type {SessionList} from "../protocol/session-list.ts";
import {SESSION_LIST_CALL_PATH, SESSION_LIST_PROGRAM} from "../protocol/session-list.ts";
import type {AnyProgram} from "../registry/program.ts";
import {Registry} from "../registry/Registry.ts";
import {programEntries} from "../shell/picker/entries.ts";
import {type AiAgentSessions, listAiAgentSessions} from "./backends.ts";
import {aiAgentProgram} from "./program.ts";
import {SESSION_LIST_WINDOW_REF} from "./renderer-ref.ts";
import {models, modes, thinking} from "./service/fixtures/scripts.ts";
import {
	type AgentScript,
	ListError,
	ScriptedAiAgent,
	type SessionSummary,
	sessionSummary,
} from "./service/index.ts";
import {
	AiAgentSessionList,
	sessionListId,
	sessionListProgram,
	sessionListSpell,
} from "./session-list.ts";

const at = (offset: number): number => 1_760_000_000_000 + offset;

const session = (id: string, backend: string, lastModified: number): SessionSummary =>
	sessionSummary({sessionId: id, backend, lastModified});

/** A backend row whose whole store is the script's `sessions`; a `ListError` there is a store that refuses. */
const backendRow = (id: string, store: ReadonlyArray<SessionSummary> | ListError): AnyProgram => {
	const script: AgentScript = {
		sessionId: `${id}-live`,
		history: [],
		modes,
		models,
		thinking,
		turns: [],
		interrupt: [],
		sessions: store,
	};
	return aiAgentProgram({
		id,
		layer: ScriptedAiAgent.layer(script),
		config: {cwd: "/workspace/phoenix"},
	});
};

const workspace = WorkspaceId.make("ws-1");
const client: Client = {id: ClientId.make("page"), workspace};

const call = new SpellCall({
	type: "spell.call",
	version: PROTOCOL_VERSION,
	id: CallId.make("c-1"),
	path: [sessionListId, "session", "list"],
	args: {},
});

const invoke: Effect.Effect<SpellReply, never, SpellExecutor> = Effect.flatMap(
	SpellExecutor,
	(executor) => executor.execute(call, client),
);

const listed = (reply: SpellReply): SessionList => {
	assert.isTrue(reply.ok, `expected a successful reply, got ${JSON.stringify(reply)}`);
	return (reply.ok ? reply.result : undefined) as SessionList;
};

const refusal = (reply: SpellReply) => {
	assert.isFalse(reply.ok, `expected a failed reply, got ${JSON.stringify(reply)}`);
	return reply.ok ? undefined : reply.error;
};

/** The executor over one program set, with the session list read out of that same registry. */
const app = (
	backends: ReadonlyArray<AnyProgram>,
	options?: {
		readonly deadlineMillis?: number;
		/** The listing the spell reads, when a test needs one the registry cannot produce. */
		readonly listing?: Layer.Layer<AiAgentSessionList>;
	},
): Layer.Layer<SpellExecutor | AiAgentSessionList> => {
	const rows = [
		sessionListProgram(
			options?.deadlineMillis === undefined ? {} : {deadlineMillis: options.deadlineMillis},
		),
		...backends,
	];
	const listing =
		options?.listing ??
		Layer.effect(
			AiAgentSessionList,
			Effect.map(Effect.context<Registry>(), (services) => ({
				read: listAiAgentSessions(services).pipe(Effect.provideContext(services)),
			})),
		).pipe(Layer.provide(Layer.orDie(Registry.layer(rows))));
	return SpellExecutor.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.orDie(SpellSet.layer({core: [], programs: rows, keys: []})),
				WindowIndex.scripted({}),
			),
		),
		// Merged rather than provided: `AnySpell` erases a spell's requirements, so the spell runs
		// under the CALLER's context and not the executor layer's — which is why `src/boot.ts` puts
		// this service in the kernel context a caller runs a spell under.
		Layer.provideMerge(listing),
	);
};

/** A listing that never answers: the store an unreachable disk mount is. */
const hangs: Layer.Layer<AiAgentSessionList> = Layer.succeed(AiAgentSessionList, {
	read: Effect.never as Effect.Effect<AiAgentSessions>,
});

describe("the session-list spell", () => {
	it.effect("unions two backends into one newest-first list with no origin split", () =>
		Effect.gen(function* () {
			const answer = listed(yield* invoke);

			assert.deepStrictEqual(
				answer.sessions.map((row) => row.sessionId),
				["pi-new", "claude-mid", "pi-old"],
			);
			assert.deepStrictEqual(
				answer.sessions.map((row) => row.backend),
				["pi", "claude", "pi"],
			);
			assert.deepStrictEqual(answer.unreadable, []);
		}).pipe(
			Effect.provide(
				app([
					backendRow("claude", [session("claude-mid", "claude", at(2_000))]),
					backendRow("pi", [
						session("pi-old", "pi", at(1_000)),
						session("pi-new", "pi", at(3_000)),
					]),
				]),
			),
		),
	);

	it.effect("names a backend that could not be read beside the rows that were", () =>
		Effect.gen(function* () {
			const answer = listed(yield* invoke);

			assert.deepStrictEqual(
				answer.sessions.map((row) => row.sessionId),
				["claude-one"],
			);
			assert.lengthOf(answer.unreadable, 1);
			assert.strictEqual(answer.unreadable[0]?.programId, "pi");
			assert.include(answer.unreadable[0]?.provenance ?? "", "@kampus/tuval/pi@");
			assert.include(answer.unreadable[0]?.detail ?? "", "the sessions directory is gone");
		}).pipe(
			Effect.provide(
				app([
					backendRow("claude", [session("claude-one", "claude", at(1_000))]),
					backendRow(
						"pi",
						new ListError({reason: "store-unreadable", detail: "the sessions directory is gone"}),
					),
				]),
			),
		),
	);

	it.effect("answers an empty list when every registered backend has no sessions", () =>
		Effect.gen(function* () {
			const answer = listed(yield* invoke);

			assert.deepStrictEqual(answer.sessions, []);
			assert.deepStrictEqual(answer.unreadable, []);
		}).pipe(Effect.provide(app([backendRow("claude", []), backendRow("pi", [])]))),
	);

	it.effect("turns an overrun into a refusal rather than a call that never answers", () =>
		Effect.gen(function* () {
			// The listing under this run never answers, so the reply below exists only because the
			// spell's own deadline produced one. Every clock here is `it.effect`'s TestClock.
			const pending = yield* Effect.forkChild(invoke);
			yield* TestClock.adjust("1000 millis");

			const error = refusal(yield* Fiber.join(pending));
			assert.strictEqual(error?.tag, "tuval/SessionListTimedOut");
			assert.include(error?.message ?? "", "1000ms");
		}).pipe(Effect.scoped, Effect.provide(app([], {deadlineMillis: 1_000, listing: hangs}))),
	);
});

describe("the session-list row", () => {
	it.effect("shows in a window, so a picker offers it like every other windowed program", () =>
		Effect.sync(() => {
			const row = sessionListProgram();
			assert.deepStrictEqual(programEntries([row]), [
				{_tag: "Program", programId: sessionListId, label: "AI agent sessions"},
			]);
			assert.deepStrictEqual(row.renderer, SESSION_LIST_WINDOW_REF);
		}),
	);

	it.effect("is registered where the page addresses its call", () =>
		Effect.sync(() => {
			// The page spells this row's id rather than importing it (`../protocol/session-list.ts`),
			// and a call at the wrong address reaches no spell at all — which is what the picker read
			// back as a refusal before #8161 landed. This is what holds the two spellings together.
			assert.strictEqual(sessionListId, SESSION_LIST_PROGRAM);
			assert.deepStrictEqual(
				[...SESSION_LIST_CALL_PATH],
				[sessionListId, ...sessionListSpell().path],
			);
		}),
	);
});
