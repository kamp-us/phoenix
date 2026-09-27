/**
 * The session list declared in a project layer, reached by the calls its window sends (#9684). The
 * project layer runs the row as `<project>/ai-agent-sessions`, while the page addresses its two
 * spells by the bare `SESSION_LIST_CALL_PATH` and `SESSION_TRANSCRIPT_CALL_PATH`. Both calls are
 * built by the page's own constructors and answered by the real executor over the rows the layered
 * loader produced, so a drift in either end reads here as an `UnknownSpell`.
 */

import {fileURLToPath} from "node:url";
import {NodeFileSystem} from "@effect/platform-node";
import {assert, describe, it} from "@effect/vitest";
import {AiAgentSessionList} from "@kampus/tuval-sdk/kernel/ai-agent/session-list";
import {AiAgentTranscripts} from "@kampus/tuval-sdk/kernel/ai-agent/session-transcript";
import type {TranscriptRequest} from "@kampus/tuval-sdk/kernel/ai-agent/transcripts";
import {SpellExecutor} from "@kampus/tuval-sdk/kernel/commands/executor";
import {type Client, WindowIndex} from "@kampus/tuval-sdk/kernel/commands/scope";
import {ClientId, WorkspaceId} from "@kampus/tuval-sdk/kernel/commands/spell";
import {SpellSet} from "@kampus/tuval-sdk/kernel/commands/spell-set";
import type {SpellCall, SpellReply} from "@kampus/tuval-sdk/kernel/protocol/messages";
import {SESSION_LIST_PROGRAM} from "@kampus/tuval-sdk/kernel/protocol/session-list";
import type {AnyProgram} from "@kampus/tuval-sdk/kernel/registry/program";
import {sessionListCall} from "@kampus/tuval-ui/session-list";
import {sessionTranscriptCall} from "@kampus/tuval-ui/session-transcript";
import {Effect, Layer} from "effect";
import {loadLayeredConfig} from "../config.ts";
import {noDesk} from "../config-fixtures/desk-layers.ts";
import {ProjectId} from "../project-id.ts";

const fixture = (name: string) =>
	fileURLToPath(new URL(`../config-fixtures/${name}.ts`, import.meta.url));

const alpha = ProjectId.of("/work/alpha");

/** No global layer at all: the session list exists only under the project's scope. */
const rows = loadLayeredConfig({
	desk: noDesk,
	global: fixture("absent-global"),
	projects: [{id: alpha, module: fixture("project-session-list")}],
}).pipe(
	Effect.map((config) => config.programs as ReadonlyArray<AnyProgram>),
	Effect.provide(NodeFileSystem.layer),
);

const client: Client = {id: ClientId.make("page"), workspace: WorkspaceId.make("ws-1")};

/** The executor over the loaded rows, with the two stores the spells read standing in as records. */
const app = (programs: ReadonlyArray<AnyProgram>, read: Array<TranscriptRequest>) =>
	SpellExecutor.layer.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.orDie(SpellSet.layer({core: [], programs, keys: []})),
				WindowIndex.scripted({}),
			),
		),
		Layer.provideMerge(
			Layer.mergeAll(
				Layer.succeed(AiAgentSessionList, {
					read: Effect.succeed({sessions: [], failures: []}),
				}),
				Layer.succeed(AiAgentTranscripts, {
					read: (request) =>
						Effect.sync(() => {
							read.push(request);
							return {items: [], next: null};
						}),
				}),
			),
		),
	);

const execute = (call: SpellCall) =>
	Effect.flatMap(SpellExecutor, (executor) => executor.execute(call, client));

const answered = (reply: SpellReply) => {
	assert.isTrue(reply.ok, `expected the call to reach its spell, got ${JSON.stringify(reply)}`);
};

describe("a project layer's session list (#9684)", () => {
	it.effect("runs under the project's scope and answers the page's bare list call", () =>
		Effect.gen(function* () {
			const programs = yield* rows;
			assert.deepStrictEqual(
				programs.map((row) => row.id),
				[alpha.scope(SESSION_LIST_PROGRAM)],
			);
			answered(yield* execute(sessionListCall()).pipe(Effect.provide(app(programs, []))));
		}),
	);

	it.effect("answers the page's bare transcript call from the same row", () =>
		Effect.gen(function* () {
			const programs = yield* rows;
			const read: Array<TranscriptRequest> = [];
			const reply = yield* execute(
				sessionTranscriptCall({
					programId: alpha.scope("claude-session"),
					sessionId: "s-1",
					cwd: "/work/alpha",
					before: null,
					limit: 20,
				}),
			).pipe(Effect.provide(app(programs, read)));
			answered(reply);
			assert.deepStrictEqual(
				read.map((request) => request.programId),
				[alpha.scope("claude-session")],
			);
		}),
	);
});
