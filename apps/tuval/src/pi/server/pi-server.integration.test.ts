/**
 * The vertical proof for this slice: a real `AgentSession` at the pinned Pi 0.84.3, driven over a
 * real loopback socket, on Pi's own faux provider so the whole run costs nothing and calls no
 * model API (`@earendil-works/pi-ai` `dist/index.d.ts` re-exports `providers/faux`).
 */

import {existsSync, mkdtempSync, readdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fauxAssistantMessage, fauxProvider} from "@earendil-works/pi-ai";
import {ModelRuntime, SessionManager} from "@earendil-works/pi-coding-agent";
import type {ProtocolError, ServerMessage, SessionSnapshot} from "@earendil-works/pi-protocol";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Layer, Redacted} from "effect";
import {layer as agentSessionHostLayer} from "./AgentSessionHost.ts";
import {SessionOpenFailed} from "./errors.ts";
import {PiServerService} from "./PiServerService.ts";
import {connectWire, type WireClient} from "./wire-fixture.ts";

const MODEL = {provider: "faux", id: "faux-1"} as const;

const response = (client: WireClient, id: string) =>
	client.next((message) => message.type === "response" && message.id === id) as Effect.Effect<
		Extract<ServerMessage, {type: "response"}>
	>;

const sessionOf = (message: Extract<ServerMessage, {type: "response"}>): SessionSnapshot => {
	if (!message.ok) throw new Error(`expected ok, got ${message.error.code}`);
	if (message.result.command === "list" || message.result.command === "detach") {
		throw new Error("no session on this result");
	}
	return message.result.session;
};

/** The first pushed snapshot at or past `revision`. Snapshots coalesce, so revisions can skip. */
const pushedSnapshot = (client: WireClient, revision: number): Effect.Effect<SessionSnapshot> =>
	client
		.next(
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.revision >= revision,
		)
		.pipe(
			Effect.map((message) => {
				if (message.type !== "event" || message.event.type !== "session_snapshot") {
					throw new Error("unreachable");
				}
				return message.event.snapshot;
			}),
		);

const errorOf = (message: Extract<ServerMessage, {type: "response"}>): ProtocolError => {
	if (message.ok) throw new Error("expected a refusal");
	return message.error;
};

const setUp = () => {
	const cwd = mkdtempSync(join(tmpdir(), "tuval-pi-"));
	const faux = fauxProvider({
		provider: MODEL.provider,
		api: "faux",
		models: [{id: MODEL.id, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
	});
	faux.setResponses([fauxAssistantMessage("hello from faux"), fauxAssistantMessage("and again")]);
	return {cwd, faux};
};

const hostLayer = (cwd: string, provider: ReturnType<typeof fauxProvider>) =>
	Layer.unwrap(
		Effect.tryPromise({
			try: async () => {
				const modelRuntime = await ModelRuntime.create({
					modelsPath: null,
					refreshOnCreate: false,
					allowModelNetwork: false,
					authPath: join(cwd, "agent", "auth.json"),
				});
				modelRuntime.registerNativeProvider(provider.provider);
				return agentSessionHostLayer({
					modelRuntime,
					agentDir: join(cwd, "agent"),
					noTools: "all",
				});
			},
			catch: (cause) => new SessionOpenFailed({cwd, detail: String(cause)}),
		}).pipe(Effect.orDie),
	);

describe("the loopback Pi server over a real AgentSession", () => {
	it.live(
		"drives a session end to end: correlation, pushed snapshots, lock, reconnect, not_found",
		() => {
			const {cwd, faux} = setUp();
			return Effect.gen(function* () {
				const server = yield* PiServerService;
				const client = yield* connectWire(Redacted.value(server.url));
				yield* client.next((message) => message.type === "hello");

				yield* client.request("create", {command: "create", cwd, model: MODEL});
				const created = sessionOf(yield* response(client, "create"));
				assert.strictEqual(created.cwd, cwd);
				assert.deepStrictEqual(created.model, MODEL);

				yield* client.request("p1", {
					command: "prompt",
					sessionId: created.id,
					text: "say hello",
				});
				yield* client.request("l1", {command: "list"});

				const listed = yield* response(client, "l1");
				assert.isTrue(listed.ok);

				const prompted = sessionOf(yield* response(client, "p1"));
				assert.deepStrictEqual(
					prompted.transcript.map((item) => item.role),
					["user", "assistant"],
				);

				const firstPush = yield* pushedSnapshot(client, 1);
				yield* client.request("p2", {
					command: "prompt",
					sessionId: created.id,
					text: "say it again",
				});
				yield* response(client, "p2");
				const secondPush = yield* pushedSnapshot(client, firstPush.revision + 1);

				assert.isAbove(secondPush.revision, firstPush.revision);
				assert.isAbove(secondPush.transcript.length, firstPush.transcript.length);

				const intruder = yield* connectWire(Redacted.value(server.url));
				yield* intruder.request("a1", {command: "attach", sessionId: created.id});
				assert.strictEqual(errorOf(yield* response(intruder, "a1")).code, "session_locked");

				yield* intruder.request("a2", {command: "attach", sessionId: "no-such-session"});
				assert.strictEqual(errorOf(yield* response(intruder, "a2")).code, "not_found");

				yield* client.request("a3", {command: "attach", sessionId: created.id});
				const reacquired = sessionOf(yield* response(client, "a3"));
				assert.isTrue(reacquired.attached);
				assert.deepStrictEqual(
					reacquired.transcript.map((item) => item.role),
					["user", "assistant", "user", "assistant"],
				);

				assert.strictEqual(faux.state.callCount, 2);
				return created.id;
			}).pipe(
				Effect.scoped,
				Effect.provide(PiServerService.layer().pipe(Layer.provide(hostLayer(cwd, faux)))),
			);
		},
		{timeout: 60_000},
	);

	it.live(
		"persists the session as JSONL under its own cwd, and the file reloads",
		() => {
			const {cwd, faux} = setUp();
			return Effect.gen(function* () {
				const server = yield* PiServerService;
				const client = yield* connectWire(Redacted.value(server.url));
				yield* client.next((message) => message.type === "hello");
				yield* client.request("create", {command: "create", cwd, model: MODEL});
				const created = sessionOf(yield* response(client, "create"));
				yield* client.request("p1", {
					command: "prompt",
					sessionId: created.id,
					text: "write me down",
				});
				yield* response(client, "p1");

				const sessionDir = join(cwd, ".tuval", "pi-sessions");
				const reloaded = SessionManager.open(
					join(sessionDir, findJsonl(sessionDir)),
					sessionDir,
					cwd,
				);
				assert.strictEqual(reloaded.getSessionId(), created.id);
				assert.include(JSON.stringify(reloaded.getEntries()), "write me down");
			}).pipe(
				Effect.scoped,
				Effect.provide(PiServerService.layer().pipe(Layer.provide(hostLayer(cwd, faux)))),
			);
		},
		{timeout: 60_000},
	);
});

const findJsonl = (dir: string): string => {
	assert.isTrue(existsSync(dir), `expected a session directory at ${dir}`);
	const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	assert.strictEqual(files.length, 1, `expected one JSONL under ${dir}, found ${files.length}`);
	return files[0] as string;
};
