/**
 * Building the layer for a test: a scripted SDK under it, a scripted `KernelBridge` beside it, and
 * the whole thing inside one Scope so a run's end is the teardown the layer owes.
 */

import type {SDKMessage, SessionMessage} from "@anthropic-ai/claude-agent-sdk";
import {Effect, Layer, Schema} from "effect";
import {Mode} from "../../../ai-agent/ports/index.ts";
import {TuvalAiAgent, type TuvalAiAgentApi} from "../../../ai-agent/service/index.ts";
import {loadFixture} from "../../history/fixtures/load.ts";
import {KernelBridge} from "../../tools/index.ts";
import {ClaudeAiAgent} from "../ClaudeAiAgent.ts";
import type {ClaudeAiAgentOptions} from "../options.ts";
import type {SpawnClaudeCodeProcess} from "../subprocess.ts";
import {type ScriptedBehaviour, type ScriptedSdk, scriptedSdk} from "./scripted-query.ts";

export const CWD = "/tmp/tuval-capture";
export const SESSION_ID = "00000000-0000-4000-8000-000000000001";
export const TOOL_SESSION_ID = "00000000-0000-4000-8000-000000000007";

/** The modes a row in these tests advertises. `plan` is the one used to prove a switch lands. */
export const MODES: ReadonlyArray<Mode> = [
	Mode.make("default"),
	Mode.make("acceptEdits"),
	Mode.make("plan"),
];

/** What `start` itself emits: starting, the handshake's ready phase, then the mode list. */
export const START_EVENTS = 3;

/**
 * Those three plus the one event the `system`/`init` frame carries: the model it names.
 *
 * That one is not part of `start` — the frame belongs to the first turn (`sdk.d.ts`), so on a
 * scripted run whose `opening` begins with `init` the pump emits it just after, and a test that
 * wants the turn behind it counts from here. `init` carries no phase: a turn's `ready` rides its
 * `result` instead (#7963).
 */
export const OPENED_EVENTS = START_EVENTS + 1;

export const messages = (name: Parameters<typeof loadFixture>[0]): ReadonlyArray<SDKMessage> =>
	loadFixture(name) as ReadonlyArray<SDKMessage>;

export const message = (name: Parameters<typeof loadFixture>[0]): SDKMessage =>
	loadFixture(name) as SDKMessage;

export const rows = (): ReadonlyArray<SessionMessage> =>
	loadFixture("session-messages") as ReadonlyArray<SessionMessage>;

export interface HarnessOptions extends ScriptedBehaviour {
	/**
	 * What the query puts on its stream. Empty by default, because a real session says nothing until
	 * a turn starts — a test that wants the `init` frame names it.
	 */
	readonly opening?: ReadonlyArray<SDKMessage>;
	readonly rows?: ReadonlyArray<SessionMessage>;
	readonly readFails?: Error;
	readonly spawn?: SpawnClaudeCodeProcess;
	readonly allowedTools?: ReadonlyArray<string>;
	readonly model?: string;
	readonly modes?: ReadonlyArray<Mode>;
	readonly permissionMode?: Mode;
	readonly version?: string;
}

/**
 * Await a promise the layer parked. It resolves or the layer is broken, so a rejection is a defect
 * rather than a case — which is also why this is not `Effect.promise`.
 */
export class ParkedRejected extends Schema.TaggedError<ParkedRejected>()(
	"tuval/claude/test/ParkedRejected",
	{detail: Schema.String},
) {}

export const settled = <A>(promise: Promise<A>): Effect.Effect<A> =>
	Effect.tryPromise({
		try: () => promise,
		catch: (cause) => new ParkedRejected({detail: String(cause)}),
	}).pipe(Effect.orDie);

const buildOptions = (harness: HarnessOptions, scripted: ScriptedSdk): ClaudeAiAgentOptions => ({
	permissionMode: harness.permissionMode ?? Mode.make("default"),
	modes: harness.modes ?? MODES,
	allowedTools: harness.allowedTools ?? [],
	sdk: scripted.sdk,
	// Pinned rather than random so the id the layer opens under is the one the captured `init`
	// fixtures name, which is what lets a test read the two as one session.
	newSessionId: () => SESSION_ID,
	...(harness.model === undefined ? {} : {model: harness.model}),
	...(harness.spawn === undefined ? {} : {spawn: harness.spawn}),
});

/**
 * Run `body` against a live layer. The scripted SDK is handed to the body too, because most of what
 * this layer owes is visible only in what it handed the SDK.
 */
export const on = <A, E>(
	harness: HarnessOptions,
	body: (agent: TuvalAiAgentApi, scripted: ScriptedSdk) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
	Effect.suspend(() => {
		const scripted = scriptedSdk({
			opening: harness.opening ?? [],
			...(harness.rows === undefined ? {} : {rows: harness.rows}),
			...(harness.readFails === undefined ? {} : {readFails: harness.readFails}),
			...(harness.version === undefined ? {} : {version: harness.version}),
			...(harness.deferOpening === undefined ? {} : {deferOpening: harness.deferOpening}),
			...(harness.endsAtOnce === undefined ? {} : {endsAtOnce: harness.endsAtOnce}),
		});
		return Effect.gen(function* () {
			const agent = yield* TuvalAiAgent;
			return yield* body(agent, scripted);
		}).pipe(
			Effect.provide(
				ClaudeAiAgent.layer(buildOptions(harness, scripted)).pipe(
					Layer.provide(KernelBridge.scripted({})),
				),
			),
			Effect.scoped,
		);
	});

/**
 * The same run, but the scripted SDK is minted by the caller so it survives the closed Scope — how
 * a teardown assertion reads what the layer did on its way out.
 */
export const onScripted = <A, E>(
	harness: HarnessOptions,
	scripted: ScriptedSdk,
	body: (agent: TuvalAiAgentApi) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
	Effect.gen(function* () {
		const agent = yield* TuvalAiAgent;
		return yield* body(agent);
	}).pipe(
		Effect.provide(
			ClaudeAiAgent.layer(buildOptions(harness, scripted)).pipe(
				Layer.provide(KernelBridge.scripted({})),
			),
		),
		Effect.scoped,
	);
