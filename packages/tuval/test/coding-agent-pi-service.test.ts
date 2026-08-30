import {mkdir, mkdtemp, rm, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {PiClient} from "@earendil-works/pi-client";
import {afterEach, assert, describe, it} from "vitest";
import {makeCodingAgentPiTransport} from "../src/backend/coding-agent-pi-service.js";

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

const writePagedSession = async (path: string, id: string): Promise<void> => {
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
	for (let index = 0; index < 79; index += 1) {
		const entryId = `${id}-${index}`;
		entries.push({
			type: "message",
			id: entryId,
			parentId,
			timestamp,
			message: {role: "user", content: `${index}:${"x".repeat(5_000)}`, timestamp: 4 + index},
		});
		parentId = entryId;
	}
	await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
};

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, {recursive: true, force: true})),
	);
});

describe("coding-agent Pi session index", () => {
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

		const client = await PiClient.connect({
			transportFactory: makeCodingAgentPiTransport({
				agentDir: root,
				cwd: "/work/project",
				sessionRoots: [sessions],
			}),
		});
		try {
			const listed = await client.listSessions();
			assert.equal(listed.filter(({id}) => id === nestedId).length, 1);
			assert.ok(listed.some(({id}) => id === subagentId));

			const nestedLease = await client.acquireSession(nestedId, {mode: "exclusive"});
			assert.deepEqual(
				nestedLease.snapshot?.transcript.flatMap((item) => transcriptText(item.content)),
				["nested fork transcript"],
			);
			await nestedLease.detach();

			const subagentLease = await client.acquireSession(subagentId, {mode: "exclusive"});
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
