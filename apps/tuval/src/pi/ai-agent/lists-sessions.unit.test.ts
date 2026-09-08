/**
 * What the Pi layer answers `listSessions` with, through the port rather than through the store
 * module beside it (#8099).
 *
 * It runs over a client pin that has no session and never dials: listing reads disk, not the
 * transport, so the answer must come back before `start` and without a socket. The store contents
 * are fixture directories, written the way `sessions.unit.test.ts` writes them.
 */

import {appendFileSync, mkdirSync, mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Logger, Schema, Stream} from "effect";
import {ListError, TuvalAiAgent} from "../../ai-agent/service/index.ts";
import {type PiClientApi, PiClientService} from "../client/index.ts";
import {aiAgentOverClient} from "./PiAiAgent.ts";

const at = (seconds: number): string => new Date(1_760_000_000_000 + seconds * 1_000).toISOString();

const temp = (): string => mkdtempSync(join(tmpdir(), "tuval-pi-listing-"));

const writeSession = (dir: string, id: string, cwd: string, seconds: number): void => {
	mkdirSync(dir, {recursive: true});
	const header = {type: "session", version: 3, id, timestamp: at(seconds), cwd};
	writeFileSync(
		join(dir, `${at(seconds).replace(/[:.]/g, "-")}_${id}.jsonl`),
		`${JSON.stringify(header)}\n`,
	);
};

/** A client that would refuse everything: nothing in this file may reach the transport. */
const idle: PiClientApi = {
	connect: Effect.die("listing must not dial"),
	reconnect: Effect.die("listing must not dial"),
	connected: Effect.succeed(false),
	createSession: () => Effect.die("listing must not open a session"),
	attachSession: () => Effect.die("listing must not open a session"),
	heldSnapshot: () => Effect.die("listing must not read a session's snapshot"),
	prompt: () => Effect.die("listing must not prompt"),
	abort: () => Effect.never,
	setModel: () => Effect.die("listing must not switch models"),
	setThinkingLevel: () => Effect.die("listing must not switch thinking levels"),
	models: Effect.succeed([]),
	snapshots: () => Stream.never,
	disconnections: Stream.never,
};

const listing = (options: {readonly agentDir: string; readonly projectRoot: string}) =>
	Effect.flatMap(TuvalAiAgent, (agent) => agent.listSessions).pipe(
		Effect.provide(
			aiAgentOverClient(options).pipe(Layer.provide(Layer.succeed(PiClientService, idle))),
		),
	);

describe("the Pi layer's listSessions", () => {
	it.effect("answers both stores before any session is started", () =>
		Effect.gen(function* () {
			const agentDir = temp();
			const projectRoot = temp();
			writeSession(join(agentDir, "sessions", "--work-phoenix--"), "cli", "/work/phoenix", 10);
			writeSession(join(projectRoot, ".tuval", "pi-sessions"), "tuval", projectRoot, 20);

			const rows = yield* listing({agentDir, projectRoot});

			assert.deepStrictEqual(
				rows.map((row) => `${row.backend}:${row.sessionId}`),
				["pi:tuval", "pi:cli"],
			);
		}),
	);

	it.effect("fails rather than answering an empty list when no store could be read", () =>
		Effect.gen(function* () {
			const agentDir = temp();
			const projectRoot = temp();
			writeFileSync(join(agentDir, "sessions"), "not a directory\n");
			mkdirSync(join(projectRoot, ".tuval"), {recursive: true});
			writeFileSync(join(projectRoot, ".tuval", "pi-sessions"), "not a directory\n");

			const error = yield* Effect.flip(listing({agentDir, projectRoot}));

			assert.isTrue(error instanceof ListError);
			assert.strictEqual(error.reason, "store-unreadable");
			assert.strictEqual(error.detail, "Pi could not enumerate the session stores");
			assert.isArray(error.cause);
			const causes = error.cause as ReadonlyArray<{cause?: unknown}>;
			assert.isTrue(causes.every((failure) => failure.cause instanceof Error));
			assert.notInclude(JSON.stringify(Schema.encodeSync(ListError)(error)), agentDir);
			assert.notInclude(JSON.stringify(Schema.encodeSync(ListError)(error)), projectRoot);
		}),
	);
});

describe("Pi stored transcript partial success", () => {
	it.effect("keeps the readable transcript and logs the original failed-store error locally", () =>
		Effect.gen(function* () {
			const agentDir = temp();
			const projectRoot = temp();
			const brokenStore = join(agentDir, "sessions");
			writeFileSync(brokenStore, "not a directory\n");
			const directory = join(projectRoot, ".tuval", "pi-sessions");
			writeSession(directory, "stored", projectRoot, 20);
			appendFileSync(
				join(directory, `${at(20).replace(/[:.]/g, "-")}_stored.jsonl`),
				`${JSON.stringify({
					type: "message",
					id: "first",
					parentId: null,
					timestamp: at(21),
					message: {role: "user", content: "Readable transcript", timestamp: Date.parse(at(21))},
				})}\n`,
			);
			const logged: unknown[] = [];
			const page = yield* Effect.flatMap(TuvalAiAgent, (agent) =>
				agent.sessionTranscript({sessionId: "stored", cwd: projectRoot, before: null, limit: 20}),
			).pipe(
				Effect.provide([
					aiAgentOverClient({agentDir, projectRoot}).pipe(
						Layer.provide(Layer.succeed(PiClientService, idle)),
					),
					Logger.layer([
						Logger.make(({message}) => {
							logged.push(message);
						}),
					]),
				]),
			);
			assert.include(JSON.stringify(page), "Readable transcript");
			assert.notInclude(JSON.stringify(page), brokenStore);
			assert.notInclude(JSON.stringify(page), "ENOTDIR");
			const log = logged.find(
				(line) =>
					Array.isArray(line) &&
					line[0] === "Pi could not enumerate the pi-cli store while reading a stored transcript",
			);
			assert.isArray(log);
			const cause = (log as unknown[])[1];
			assert.isTrue(cause instanceof Error);
			assert.propertyVal(cause, "code", "ENOTDIR");
			assert.propertyVal(cause, "path", brokenStore);
			assert.propertyVal(cause, "syscall", "scandir");
		}),
	);
});
