import {mkdir, mkdtemp, rm, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {PiClient} from "@earendil-works/pi-client";
import {createAgentSession} from "@earendil-works/pi-coding-agent";
import {afterEach, assert, describe, it} from "vitest";
import {makeCodingAgentPiTransport} from "../src/backend/coding-agent-pi-service.js";
import {PiLiveSessionState} from "../src/backend/live-session-state.js";

const temporaryRoots: Array<string> = [];
const productionProvider = fileURLToPath(
	new URL("./fixtures/production-coding-agent", import.meta.url),
);

const writeSession = async (
	path: string,
	id: string,
	text: string,
	parentSession?: string,
): Promise<void> => {
	await mkdir(dirname(path), {recursive: true});
	const timestamp = "2026-08-29T10:00:00.000Z";
	const entries = [
		{
			type: "session",
			version: 3,
			id,
			timestamp,
			cwd: `/work/${id}`,
			...(parentSession === undefined ? {} : {parentSession}),
		},
		{
			type: "model_change",
			id: `${id}-model`,
			parentId: null,
			timestamp,
			provider: "tuval-faux",
			modelId: "daily-driver",
		},
		{
			type: "thinking_level_change",
			id: `${id}-thinking`,
			parentId: `${id}-model`,
			timestamp,
			thinkingLevel: "high",
		},
		{
			type: "message",
			id: `${id}-message`,
			parentId: `${id}-thinking`,
			timestamp,
			message: {role: "user", content: text, timestamp: Date.parse(timestamp)},
		},
	];
	await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
};

const transcriptText = (content: ReadonlyArray<{readonly type: string; readonly text?: string}>) =>
	content.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []));

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

const writeProductionSettings = (root: string): Promise<void> =>
	writeFile(
		join(root, "settings.json"),
		`${JSON.stringify({
			defaultProvider: "tuval-faux",
			defaultModel: "daily-driver",
			packages: [productionProvider],
		})}\n`,
	);

const writePagedSession = async (
	path: string,
	id: string,
	messageCount = 79,
	messageBytes = 5_000,
): Promise<void> => {
	await mkdir(dirname(path), {recursive: true});
	const timestamp = "2026-08-29T10:00:00.000Z";
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
	};
	const entries: Array<Record<string, unknown>> = [
		{type: "session", version: 3, id, timestamp, cwd: `/work/${id}`},
		{
			type: "model_change",
			id: `${id}-model`,
			parentId: null,
			timestamp,
			provider: "tuval-faux",
			modelId: "daily-driver",
		},
		{
			type: "message",
			id: `${id}-first`,
			parentId: `${id}-model`,
			timestamp,
			message: {role: "user", content: "first", timestamp: 1},
		},
		{
			type: "message",
			id: `${id}-call`,
			parentId: `${id}-first`,
			timestamp,
			message: {
				role: "assistant",
				content: [{type: "toolCall", id: "call-1", name: "read", arguments: {path: "x"}}],
				api: "openai-completions",
				provider: "tuval-faux",
				model: "daily-driver",
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: `${id}-result`,
			parentId: `${id}-call`,
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{type: "text", text: "paired result"}],
				details: {},
				isError: false,
				timestamp: 3,
			},
		},
	];
	let parentId = `${id}-result`;
	for (let index = 0; index < messageCount; index += 1) {
		const entryId = `${id}-${index}`;
		entries.push({
			type: "message",
			id: entryId,
			parentId,
			timestamp,
			message: {
				role: "user",
				content: `${index}:${"x".repeat(messageBytes)}`,
				timestamp: 4 + index,
			},
		});
		parentId = entryId;
	}
	await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
};

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((root) => rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 20})),
	);
});

describe("coding-agent Pi session index", () => {
	it("acknowledges bounded history before slow runtime construction and publishes readiness", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-coding-agent-slow-"));
		temporaryRoots.push(root);
		const sessions = join(root, "sessions");
		const id = "slow-runtime";
		await writePagedSession(
			join(sessions, `2026-08-29T10-00-00-000Z_${id}.jsonl`),
			id,
			450,
			10_000,
		);
		await writeProductionSettings(root);
		let releaseConstruction: () => void = () => undefined;
		const constructionGate = new Promise<void>((resolve) => {
			releaseConstruction = resolve;
		});
		const transport = makeCodingAgentPiTransport({
			agentDir: root,
			cwd: "/work/project",
			sessionRoots: [sessions],
			createAgentSession: async (options) => {
				await constructionGate;
				return createAgentSession(options);
			},
		});
		const state = await PiLiveSessionState.connect(transport, {
			transcriptArchive: transport,
			runtimeLifecycle: transport,
		});
		try {
			const startedAt = performance.now();
			const attached = await state.attach(id);
			assert.ok(performance.now() - startedAt < 750, "attach acknowledgement exceeded 750ms");
			assert.equal(attached._tag, "attached");
			if (attached._tag !== "attached") return;
			assert.deepEqual(attached.session.runtime, {_tag: "loading"});
			assert.ok(attached.session.transcript.length <= 40);
			assert.ok(Buffer.byteLength(JSON.stringify(attached), "utf8") < 300_000);
			assert.equal(attached.session.archive._tag, "more");
			assert.equal(attached.session.controls?.create, false);
			assert.equal(attached.session.controls?.open, false);
			assert.equal(attached.session.controls?.setModel, false);

			releaseConstruction();
			await waitFor(() => state.current()?.runtime._tag === "ready", "runtime readiness");
			const ready = state.current();
			assert.equal(ready?.runtime._tag, "ready");
			assert.equal(ready?.controls?.create, true);
			assert.ok(
				state
					.eventsAfter()
					.filter((event) => event._tag === "session")
					.some((event) => event.session.runtime._tag === "ready"),
			);
		} finally {
			await state.dispose();
		}
	});

	it("cancels before acknowledgement without retaining ownership or the late runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-coding-agent-abort-"));
		temporaryRoots.push(root);
		const sessions = join(root, "sessions");
		const id = "aborted-runtime";
		await writeSession(join(sessions, `2026-08-29T10-00-00-000Z_${id}.jsonl`), id, "history");
		await writeProductionSettings(root);
		let releaseConstruction: () => void = () => undefined;
		const constructionGate = new Promise<void>((resolve) => {
			releaseConstruction = resolve;
		});
		let disposed = 0;
		const transport = makeCodingAgentPiTransport({
			agentDir: root,
			cwd: "/work/project",
			sessionRoots: [sessions],
			createAgentSession: async (options) => {
				await constructionGate;
				const result = await createAgentSession(options);
				const dispose = result.session.dispose.bind(result.session);
				result.session.dispose = () => {
					disposed += 1;
					dispose();
				};
				return result;
			},
		});
		const cancelled = await PiLiveSessionState.connect(transport, {runtimeLifecycle: transport});
		const controller = new AbortController();
		controller.abort();
		try {
			assert.deepInclude(await cancelled.attach(id, undefined, controller.signal), {
				_tag: "refused",
				code: "protocol",
			});
			assert.equal(cancelled.current(), null);
			assert.equal(disposed, 0);
			releaseConstruction();

			const retried = await PiLiveSessionState.connect(transport, {runtimeLifecycle: transport});
			try {
				assert.equal((await retried.attach(id))._tag, "attached");
				await waitFor(() => retried.current()?.runtime._tag === "ready", "cancel retry readiness");
			} finally {
				await retried.dispose();
			}
		} finally {
			await cancelled.dispose();
		}
	});

	it("releases loading ownership and disposes every late construction", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-coding-agent-cancel-"));
		temporaryRoots.push(root);
		const sessions = join(root, "sessions");
		const id = "cancelled-runtime";
		await writeSession(join(sessions, `2026-08-29T10-00-00-000Z_${id}.jsonl`), id, "history");
		await writeProductionSettings(root);
		let releaseConstruction: () => void = () => undefined;
		const constructionGate = new Promise<void>((resolve) => {
			releaseConstruction = resolve;
		});
		let disposed = 0;
		const transport = makeCodingAgentPiTransport({
			agentDir: root,
			cwd: "/work/project",
			sessionRoots: [sessions],
			createAgentSession: async (options) => {
				await constructionGate;
				const result = await createAgentSession(options);
				const dispose = result.session.dispose.bind(result.session);
				result.session.dispose = () => {
					disposed += 1;
					dispose();
				};
				return result;
			},
		});
		const first = await PiLiveSessionState.connect(transport, {runtimeLifecycle: transport});
		const second = await PiLiveSessionState.connect(transport, {runtimeLifecycle: transport});
		const disconnected = await PiLiveSessionState.connect(transport, {runtimeLifecycle: transport});
		try {
			assert.equal((await first.attach(id))._tag, "attached");
			assert.deepInclude(await first.release(), {_tag: "released", sessionId: id});
			const reattached = await second.attach(id);
			assert.equal(reattached._tag, "attached");
			if (reattached._tag === "attached") {
				assert.deepEqual(reattached.session.runtime, {_tag: "loading"});
			}
			assert.deepInclude(await second.release(), {_tag: "released", sessionId: id});
			assert.equal((await disconnected.attach(id))._tag, "attached");
			await disconnected.dispose();
			releaseConstruction();
			await waitFor(() => disposed === 3, "late runtime disposal");
			assert.equal(disposed, 3);
		} finally {
			await first.dispose();
			await second.dispose();
			await disconnected.dispose();
		}
	});

	it("makes selection swap and reconnect during loading deterministic", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-coding-agent-reconnect-"));
		temporaryRoots.push(root);
		const sessions = join(root, "sessions");
		const firstId = "loading-first";
		const secondId = "loading-second";
		await writeSession(
			join(sessions, `2026-08-29T10-00-00-000Z_${firstId}.jsonl`),
			firstId,
			"first history",
		);
		await writeSession(
			join(sessions, `2026-08-29T10-00-00-000Z_${secondId}.jsonl`),
			secondId,
			"second history",
		);
		await writeProductionSettings(root);
		let releaseConstruction: () => void = () => undefined;
		const constructionGate = new Promise<void>((resolve) => {
			releaseConstruction = resolve;
		});
		let attempts = 0;
		let disposed = 0;
		const transport = makeCodingAgentPiTransport({
			agentDir: root,
			cwd: "/work/project",
			sessionRoots: [sessions],
			createAgentSession: async (options) => {
				attempts += 1;
				await constructionGate;
				const result = await createAgentSession(options);
				const dispose = result.session.dispose.bind(result.session);
				result.session.dispose = () => {
					disposed += 1;
					dispose();
				};
				return result;
			},
		});
		const original = await PiLiveSessionState.connect(transport, {runtimeLifecycle: transport});
		assert.equal((await original.attach(firstId))._tag, "attached");
		assert.equal((await original.attach(secondId))._tag, "attached");
		assert.equal(original.current()?.sessionId, secondId);
		await original.dispose();

		const reconnected = await PiLiveSessionState.connect(transport, {runtimeLifecycle: transport});
		try {
			const attached = await reconnected.attach(firstId);
			assert.equal(attached._tag, "attached");
			if (attached._tag === "attached") {
				assert.deepEqual(attached.session.runtime, {_tag: "loading"});
			}
			assert.equal(attempts, 3);
			releaseConstruction();
			await waitFor(() => reconnected.current()?.runtime._tag === "ready", "reconnected runtime");
			await waitFor(() => disposed === 2, "superseded runtime disposal");
			assert.equal(reconnected.current()?.sessionId, firstId);
			assert.equal(reconnected.current()?.runtime._tag, "ready");
		} finally {
			await reconnected.dispose();
		}
		assert.equal(disposed, 3);
	});

	it("refuses timed-out construction, releases ownership, and disposes its late runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-coding-agent-timeout-"));
		temporaryRoots.push(root);
		const sessions = join(root, "sessions");
		const id = "timed-out-runtime";
		await writeSession(join(sessions, `2026-08-29T10-00-00-000Z_${id}.jsonl`), id, "history");
		await writeProductionSettings(root);
		let releaseConstruction: () => void = () => undefined;
		const constructionGate = new Promise<void>((resolve) => {
			releaseConstruction = resolve;
		});
		let disposed = 0;
		const transport = makeCodingAgentPiTransport({
			agentDir: root,
			cwd: "/work/project",
			sessionRoots: [sessions],
			operationTimeoutMs: 50,
			createAgentSession: async (options) => {
				await constructionGate;
				const result = await createAgentSession(options);
				const dispose = result.session.dispose.bind(result.session);
				result.session.dispose = () => {
					disposed += 1;
					dispose();
				};
				return result;
			},
		});
		const timedOut = await PiLiveSessionState.connect(transport, {runtimeLifecycle: transport});
		const next = await PiLiveSessionState.connect(transport, {runtimeLifecycle: transport});
		try {
			assert.equal((await timedOut.attach(id))._tag, "attached");
			await waitFor(() => timedOut.current()?.runtime._tag === "refused", "runtime timeout");
			const refusal = timedOut.current()?.runtime;
			assert.match(refusal?._tag === "refused" ? refusal.reason : "", /exceeded 50ms/);
			assert.equal((await next.attach(id))._tag, "attached");
			await next.release();
			releaseConstruction();
			await waitFor(() => disposed === 2, "timed-out runtime disposal");
			assert.equal(disposed, 2);
		} finally {
			await timedOut.dispose();
			await next.dispose();
		}
	});

	it("disposes an AgentSession that completes after create timeout", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-coding-agent-create-timeout-"));
		temporaryRoots.push(root);
		await writeProductionSettings(root);
		let releaseConstruction: () => void = () => undefined;
		const constructionGate = new Promise<void>((resolve) => {
			releaseConstruction = resolve;
		});
		let disposed = 0;
		const transport = makeCodingAgentPiTransport({
			agentDir: root,
			cwd: "/work/project",
			sessionRoots: [join(root, "sessions")],
			operationTimeoutMs: 50,
			createAgentSession: async (options) => {
				await constructionGate;
				const result = await createAgentSession(options);
				const dispose = result.session.dispose.bind(result.session);
				result.session.dispose = () => {
					disposed += 1;
					dispose();
				};
				return result;
			},
		});
		const client = await PiClient.connect({transportFactory: transport});
		try {
			let refusal = "";
			try {
				await client.createSession();
			} catch (error) {
				refusal = error instanceof Error ? error.message : String(error);
			}
			assert.match(refusal, /exceeded 50ms/);
			releaseConstruction();
			await waitFor(() => disposed === 1, "late created runtime disposal");
		} finally {
			await client.dispose();
		}
	});

	it("publishes a reason-bearing refusal and retries the same retained session", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-coding-agent-refused-"));
		temporaryRoots.push(root);
		const sessions = join(root, "sessions");
		const id = "refused-runtime";
		await writeSession(join(sessions, `2026-08-29T10-00-00-000Z_${id}.jsonl`), id, "history");
		await writeProductionSettings(root);
		let attempts = 0;
		const transport = makeCodingAgentPiTransport({
			agentDir: root,
			cwd: "/work/project",
			sessionRoots: [sessions],
			createAgentSession: async (options) => {
				attempts += 1;
				if (attempts === 1) throw new Error("fixture runtime refused");
				return createAgentSession(options);
			},
		});
		const state = await PiLiveSessionState.connect(transport, {runtimeLifecycle: transport});
		try {
			assert.equal((await state.attach(id))._tag, "attached");
			await waitFor(() => state.current()?.runtime._tag === "refused", "runtime refusal");
			assert.deepEqual(state.current()?.runtime, {
				_tag: "refused",
				reason: "fixture runtime refused",
			});
			assert.equal(state.current()?.controls?.create, false);
			const retried = await state.attach(id);
			assert.equal(retried._tag, "attached");
			await waitFor(() => state.current()?.runtime._tag === "ready", "retried runtime readiness");
			assert.equal(attempts, 2);
		} finally {
			await state.dispose();
		}
	});

	it("pages bounded archive windows without splitting a tool call from its result", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-coding-agent-pages-"));
		temporaryRoots.push(root);
		const sessions = join(root, "sessions");
		const id = "paged-session";
		await writePagedSession(join(sessions, `2026-08-29T10-00-00-000Z_${id}.jsonl`), id);
		await writeFile(
			join(root, "settings.json"),
			`${JSON.stringify({
				defaultProvider: "tuval-faux",
				defaultModel: "daily-driver",
				packages: [productionProvider],
			})}\n`,
		);
		const transport = makeCodingAgentPiTransport({
			agentDir: root,
			cwd: "/work/project",
			sessionRoots: [sessions],
		});
		const client = await PiClient.connect({transportFactory: transport});
		try {
			const lease = await client.acquireSession(id, {mode: "exclusive"});
			const snapshot = lease.snapshot;
			assert.ok(snapshot !== undefined);
			assert.ok(snapshot.transcript.length <= 40);
			assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") < 300_000);
			const archive = transport.archiveState(id, snapshot.transcript);
			assert.equal(archive._tag, "more");
			if (archive._tag !== "more") return;
			const firstPage = await transport.loadOlder(archive.cursor);
			assert.equal(firstPage._tag, "loaded");
			if (firstPage._tag !== "loaded") return;
			const toolIndex = firstPage.transcript.findIndex((entry) => entry.role === "assistant");
			assert.ok(toolIndex >= 0);
			assert.equal(firstPage.transcript[toolIndex + 1]?.role, "tool");
			assert.deepEqual(
				firstPage.transcript.slice(toolIndex, toolIndex + 2).map(({id: entryId}) => entryId),
				[`${id}:1`, `${id}:2`],
			);
			assert.equal(firstPage.archive._tag, "more");
			const stale = await transport.loadOlder(`${archive.cursor}broken`);
			assert.equal(stale._tag, "refused");
			if (stale._tag === "refused") assert.equal(stale.code, "invalid-cursor");
			const progressEvents: Array<unknown> = [];
			const unsubscribe = lease.onEvent((event) => {
				if (event.type === "session_progress") progressEvents.push(event);
			});
			await lease.prompt("incremental update");
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("coding-agent prompt emitted no incremental progress")),
					2_000,
				);
				const poll = () => {
					if (progressEvents.length > 0) {
						clearTimeout(timeout);
						resolve();
					} else setTimeout(poll, 10);
				};
				poll();
			});
			unsubscribe();
			assert.ok(Buffer.byteLength(JSON.stringify(progressEvents[0]), "utf8") < 50_000);
			await lease.detach();
		} finally {
			await client.dispose();
		}
	});

	it("deduplicates and attaches nested fork and subagent session layouts", async () => {
		const root = await mkdtemp(join(tmpdir(), "tuval-coding-agent-index-"));
		temporaryRoots.push(root);
		const sessions = join(root, "sessions");
		const parent = join(sessions, "--project", "2026-08-25T08-00-00-000Z_parent.jsonl");
		const nestedId = "01a0380e-09d2-76ea-8820-e457418b0217";
		const nested = join(
			sessions,
			"--project",
			"parent",
			"forks",
			`2026-08-25T08-33-59-250Z_${nestedId}.jsonl`,
		);
		const duplicate = join(
			sessions,
			"--project-copy",
			`2026-08-24T08-33-59-250Z_${nestedId}.jsonl`,
		);
		const subagentId = "subagent-session";
		const subagent = join(
			sessions,
			"--project",
			"parent",
			"session",
			"child",
			"run-0",
			"session.jsonl",
		);
		await writeSession(parent, "parent", "parent transcript");
		await writeSession(duplicate, nestedId, "stale duplicate", parent);
		await writeSession(nested, nestedId, "nested fork transcript", parent);
		await writeSession(subagent, subagentId, "subagent transcript", parent);
		await utimes(duplicate, new Date(1_000), new Date(1_000));
		await utimes(nested, new Date(2_000), new Date(2_000));
		await writeFile(
			join(root, "settings.json"),
			`${JSON.stringify({
				defaultProvider: "tuval-faux",
				defaultModel: "daily-driver",
				packages: [productionProvider],
			})}\n`,
		);

		const transport = makeCodingAgentPiTransport({
			agentDir: root,
			cwd: "/work/project",
			sessionRoots: [sessions],
		});
		const client = await PiClient.connect({transportFactory: transport});
		try {
			const listed = await client.listSessions();
			assert.equal(listed.filter(({id}) => id === nestedId).length, 1);
			assert.ok(listed.some(({id}) => id === subagentId));

			const nestedLease = await client.acquireSession(nestedId, {mode: "exclusive"});
			await waitFor(
				() => transport.currentRuntime(nestedId)?.state._tag === "ready",
				"nested runtime",
			);
			assert.deepEqual(
				nestedLease.snapshot?.transcript.flatMap((item) => transcriptText(item.content)),
				["nested fork transcript"],
			);
			await nestedLease.detach();

			const subagentLease = await client.acquireSession(subagentId, {mode: "exclusive"});
			await waitFor(
				() => transport.currentRuntime(subagentId)?.state._tag === "ready",
				"subagent runtime",
			);
			assert.deepEqual(
				subagentLease.snapshot?.transcript.flatMap((item) => transcriptText(item.content)),
				["subagent transcript"],
			);
			await subagentLease.detach();
		} finally {
			await client.dispose();
		}
	});
});
