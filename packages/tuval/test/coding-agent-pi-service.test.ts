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

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, {recursive: true, force: true})),
	);
});

describe("coding-agent Pi session index", () => {
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
