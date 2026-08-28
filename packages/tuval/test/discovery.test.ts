import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as Schema from "effect/Schema";
import {afterEach, describe, expect, it} from "vitest";
import {discoverPiSessions} from "../src/backend/pi-discovery.js";
import {DiscoveryOutcome} from "../src/shared/discovery.js";

const decodeOutcome = Schema.decodeUnknownSync(DiscoveryOutcome);

const temporary: Array<string> = [];

const temp = async (): Promise<string> => {
	const path = await mkdtemp(join(tmpdir(), "tuval-discovery-"));
	temporary.push(path);
	return path;
};

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, {recursive: true, force: true})));
});

describe("pi home discovery", () => {
	it("discovers controlled homes with filename-stable identities and isolates malformed sessions", async () => {
		const root = await temp();
		const project = join(root, "--Users-test-project");
		await mkdir(project);
		await writeFile(
			join(project, "2026-08-27T12-00-00-000Z_filename-session.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "copied-header-id",
				timestamp: "2026-08-27T12:00:00.000Z",
				cwd: "/Users/test/project",
			})}\n${JSON.stringify({type: "message"})}\n`,
		);
		await writeFile(join(project, "2026-08-27T12-01-00-000Z_broken.jsonl"), "not-json\n");

		const first = await discoverPiSessions({sessionRoots: [root]});
		const second = await discoverPiSessions({sessionRoots: [root]});

		expect(() => decodeOutcome(first)).not.toThrow();
		expect(first._tag).toBe("partial-source");
		if (first._tag !== "partial-source" || second._tag !== "partial-source") return;
		expect(first.sessions).toHaveLength(1);
		expect(first.sessions[0]).toMatchObject({
			identity: "pi:filename-session",
			piSessionId: "filename-session",
			cwd: "/Users/test/project",
		});
		expect(second.sessions[0]?.identity).toBe(first.sessions[0]?.identity);
		expect(first.problems).toEqual([
			expect.objectContaining({message: "session header is not valid JSON"}),
		]);
	});

	it("distinguishes empty, fatal, and framed transport failures", async () => {
		const root = await temp();
		const empty = await discoverPiSessions({sessionRoots: [join(root, "missing")]});
		expect(() => decodeOutcome(empty)).not.toThrow();
		expect(empty).toEqual({
			_tag: "empty",
			sessions: [],
		});

		const notDirectory = join(root, "not-a-directory");
		await writeFile(notDirectory, "x");
		const fatal = await discoverPiSessions({sessionRoots: [notDirectory]});
		expect(() => decodeOutcome(fatal)).not.toThrow();
		expect(fatal).toMatchObject({_tag: "fatal"});

		const transport = await discoverPiSessions({
			sessionRoots: [join(root, "missing")],
			transport: {failWith: new Error("synthetic transport break")},
		});
		expect(() => decodeOutcome(transport)).not.toThrow();
		expect(transport).toEqual({
			_tag: "transport",
			message: "synthetic transport break",
			retryable: true,
		});
	});
});
