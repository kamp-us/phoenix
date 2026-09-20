/**
 * `sessionTranscript`'s three-way store read, driven through the published `TuvalAiAgent` (#8686).
 *
 * The reader underneath is covered by `transcript.unit.test.ts`. What is proven here is the
 * wrapper's own fork — its `exists` guard on the conversation directory, and its mapping of the
 * reader's `PlanRefusal` onto `TranscriptError` — i.e. that the three reasons come back *distinct*
 * at the port, and that an existing conversation with no log yet is a page rather than a missing
 * session. Shaped after `../../codex/agent.unit.test.ts`'s own distinctness case.
 *
 * Every home below is a disposable temporary directory: the layer resolves `homedir()` when it is
 * given none, and a test that read the invoking user's real store would assert about his machine.
 */

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, describe, expect, it} from "@effect/vitest";
import {Effect} from "effect";
import type {TranscriptQuery, TuvalAiAgentApi} from "../../ai-agent/service/index.ts";
import {TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {agyChildStub, agyLayerOver} from "./child-stub.ts";
import {conversationDir, TRANSCRIPT_FILE, transcriptLogDir} from "./transcript.ts";
import * as fixtures from "./transcript-fixtures.ts";

const CID = fixtures.conversationId;
const CWD = "/tuval/agy-session-transcript";

const query: TranscriptQuery = {sessionId: CID, cwd: CWD, before: null, limit: 10};

const homes: Array<string> = [];

const freshHome = (): string => {
	const home = mkdtempSync(join(tmpdir(), "agy-session-transcript-"));
	homes.push(home);
	return home;
};

/** A store holding no conversation at all — the directory the id names is nowhere. */
const storeWithout = freshHome;

/** A store holding the conversation, with the log agy writes as the turns run or without it yet. */
const storeHolding = (transcript?: string): string => {
	const home = freshHome();
	if (transcript === undefined) mkdirSync(conversationDir(home, CID), {recursive: true});
	else {
		mkdirSync(transcriptLogDir(home, CID), {recursive: true});
		writeFileSync(join(transcriptLogDir(home, CID), TRANSCRIPT_FILE), transcript);
	}
	return home;
};

/**
 * A store the read cannot be answered for. `$HOME/.gemini` is a regular *file*, so `access` on the
 * conversation path below it fails `ENOTDIR` — the forcing constraint, because `FileSystem.exists`
 * folds only `NotFound` to `false` and a merely absent path would take the missing-session arm
 * instead (`effect/FileSystem.ts`'s `make`; `ENOTDIR` maps to `BadResource` in
 * `@effect/platform-node-shared`'s `handleErrnoException`).
 */
const unreadableStore = (): string => {
	const home = freshHome();
	writeFileSync(join(home, ".gemini"), "not a directory");
	return home;
};

const conversation = [
	fixtures.userInput,
	fixtures.toolCall,
	fixtures.toolResult,
	fixtures.assistantReply,
].join("\n");

const onAgy = <A, E>(home: string, body: (agent: TuvalAiAgentApi) => Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const child = yield* agyChildStub;
		return yield* Effect.gen(function* () {
			return yield* body(yield* TuvalAiAgent);
		}).pipe(Effect.provide(agyLayerOver(child, home)), Effect.scoped);
	});

afterAll(() => {
	for (const home of homes) rmSync(home, {recursive: true, force: true});
});

describe("the agy layer's stored-transcript read", () => {
	it.effect("reads a conversation this store does not hold as a missing session", () =>
		onAgy(storeWithout(), (agent) =>
			Effect.gen(function* () {
				expect(yield* Effect.flip(agent.sessionTranscript(query))).toMatchObject({
					reason: "session-not-found",
					sessionId: CID,
				});
			}),
		),
	);

	it.effect(
		"reads a store that will not answer as unreadable rather than as a missing session",
		() =>
			onAgy(unreadableStore(), (agent) =>
				Effect.gen(function* () {
					const failure = yield* Effect.flip(agent.sessionTranscript(query));
					expect(failure).toMatchObject({reason: "store-unreadable", sessionId: CID});
					expect(failure.detail).not.toBe("");
				}),
			),
	);

	it.effect("refuses a cursor no stored item carries, carrying the reader's own reason", () =>
		onAgy(storeHolding(conversation), (agent) =>
			Effect.gen(function* () {
				expect(
					yield* Effect.flip(agent.sessionTranscript({...query, before: "no-such-item"})),
				).toMatchObject({
					reason: "unknown-cursor",
					sessionId: CID,
					detail: "cursor-not-found",
				});
			}),
		),
	);

	it.effect("serves an empty page for a held conversation agy has written no log for yet", () =>
		onAgy(storeHolding(), (agent) =>
			Effect.gen(function* () {
				expect(yield* agent.sessionTranscript(query)).toEqual({items: [], hasMore: false});
			}),
		),
	);

	/**
	 * The cross-arm claim the three reasons exist for: collapse any two of them in `AgyAiAgent.ts`
	 * and this reds, where each case above would still pass on its own.
	 */
	it.effect("keeps the three refusals and an ordinary page distinct from one another", () =>
		Effect.gen(function* () {
			const reasons = [
				yield* onAgy(storeWithout(), (agent) =>
					Effect.map(Effect.flip(agent.sessionTranscript(query)), (failure) => failure.reason),
				),
				yield* onAgy(unreadableStore(), (agent) =>
					Effect.map(Effect.flip(agent.sessionTranscript(query)), (failure) => failure.reason),
				),
				yield* onAgy(storeHolding(conversation), (agent) =>
					Effect.map(
						Effect.flip(agent.sessionTranscript({...query, before: "no-such-item"})),
						(failure) => failure.reason,
					),
				),
			];
			expect(reasons).toEqual(["session-not-found", "store-unreadable", "unknown-cursor"]);
			expect(new Set(reasons).size).toBe(3);
			expect(
				yield* onAgy(storeHolding(conversation), (agent) => agent.sessionTranscript(query)),
			).toMatchObject({hasMore: false});
		}),
	);
});
