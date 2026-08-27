import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {delimiter, join} from "node:path";
import {Effect, Layer} from "effect";
import {afterEach, describe, expect, it} from "vitest";
import {discoverSessions} from "./discovery.ts";
import {
	configuredAgentDirs,
	makePiAccess,
	PiAccess,
	PiFatalError,
	PiTransportError,
	sessionIdentity,
} from "./pi-access.ts";

const cleanup: Array<string> = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, {recursive: true, force: true})));
});

const controlledAgentDir = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "tuval-pi-"));
	cleanup.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(agentDir, "sessions", "--project--");
	await mkdir(projectDir, {recursive: true});
	await writeFile(
		join(projectDir, "valid.jsonl"),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "session-1",
			timestamp: "2026-08-26T10:00:00.000Z",
			cwd: "/workspace",
		})}\n`,
	);
	await writeFile(join(projectDir, "malformed.jsonl"), "not-json\n");
	return agentDir;
};

describe("pi session discovery", () => {
	it("discovers a controlled pi home and isolates malformed entries", async () => {
		const agentDir = await controlledAgentDir();
		const scans = await Effect.runPromise(makePiAccess([agentDir]).scan);
		expect(scans).toHaveLength(1);
		expect(scans[0]?.sessions).toHaveLength(1);
		expect(scans[0]?.source.skippedEntries).toBe(1);
		expect(scans[0]?.issues[0]).toContain("skipped 1 malformed session entry");

		const outcome = await Effect.runPromise(
			discoverSessions.pipe(Effect.provide(Layer.succeed(PiAccess, makePiAccess([agentDir])))),
		);
		expect(outcome.kind).toBe("partial");
		expect(outcome.sessions[0]?.identity).toEqual(sessionIdentity(agentDir, "session-1"));
		expect(sessionIdentity(agentDir, "session-1")).toEqual(sessionIdentity(agentDir, "session-1"));
	});

	it("resolves the real pi home convention and configured homes", () => {
		expect(configuredAgentDirs({}, "/home/person")).toEqual(["/home/person/.pi/agent"]);
		expect(
			configuredAgentDirs(
				{TUVAL_PI_HOMES: [`/first/.pi`, `/second/.pi`].join(delimiter)},
				"/unused",
			),
		).toEqual(["/first/.pi/agent", "/second/.pi/agent"]);
	});

	it("keeps transport and fatal failures distinct", async () => {
		for (const [failure, kind] of [
			[new PiTransportError({message: "offline"}), "transport"],
			[new PiFatalError({message: "broken invariant"}), "fatal"],
		] as const) {
			const outcome = await Effect.runPromise(
				discoverSessions.pipe(
					Effect.provide(Layer.succeed(PiAccess, {scan: Effect.fail(failure)})),
				),
			);
			expect(outcome).toMatchObject({kind, message: failure.message, sessions: [], sources: []});
		}
	});
});
