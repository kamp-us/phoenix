import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs, fakeShell} from "../fakes.test-support.ts";
import type {ChildOutcome, ChildRequest, ChildRunner} from "../io/exec.ts";
import {
	MALFORMED_RECORD,
	NO_WORKSPACE,
	OFF_VOCABULARY,
	READ_OR_EXEC_UNKNOWN,
	WORKSPACE_IN_TREE,
} from "./codes.ts";
import {
	EVIDENCE,
	evidenceRecord,
	evidenceText,
	MANIFEST,
	manifestText,
	NONCE,
	ONE_RUN,
	TMP_ROOT,
	WORKSPACE,
} from "./fixtures.test-support.ts";
import {childEnv, isCredentialName, runRun} from "./run-verb.ts";
import {parseEvidence, sha256OfText} from "./workspace.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const ran = (overrides: Partial<Extract<ChildOutcome, {_tag: "Ran"}>> = {}): ChildOutcome => ({
	_tag: "Ran",
	exitCode: 0,
	timedOut: false,
	stdout: bytes("no\n"),
	stderr: bytes(""),
	truncated: false,
	...overrides,
});

const resident: FakeFsOptions = {directories: [WORKSPACE], files: {[MANIFEST]: manifestText()}};

const options = {
	nonce: NONCE,
	timeout: 300,
	env: [] as ReadonlyArray<string>,
	command: ["printf", "no\\n"] as ReadonlyArray<string>,
	parentEnv: {PATH: "/usr/bin", GH_TOKEN: "secret", HOME: "/home/agent"} as Record<
		string,
		string | undefined
	>,
	tmpRoot: TMP_ROOT,
	spawn: ((_request: ChildRequest) => Effect.succeed(ran())) as ChildRunner,
};

const run = (overrides: Partial<typeof options> = {}, fs: FakeFsOptions = resident) => {
	const disk = fakeFs(fs);
	const requests: ChildRequest[] = [];
	const spawn = (request: ChildRequest) => {
		requests.push(request);
		return (overrides.spawn ?? options.spawn)(request);
	};
	return Effect.runPromise(
		Effect.provide(
			runRun({...options, ...overrides, spawn}),
			Layer.merge(disk.layer, fakeShell([]).layer),
		),
	).then((outcome) => ({outcome, written: disk.written, requests}));
};

describe("runRun records what happened, whatever the command returned", () => {
	it("answers the record and seats it on exit 0", async () => {
		const {outcome} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			nonce: NONCE,
			seq: 1,
			command: ["printf", "no\\n"],
			commandExit: 0,
			timedOut: false,
			outBytes: 3,
			errBytes: 0,
			truncated: false,
			outSha256: sha256OfText("no\n"),
			errSha256: sha256OfText(""),
		});
	});

	it("keeps `ran and answered no` at exit 0 with the status in the payload", async () => {
		const {outcome} = await run({spawn: () => Effect.succeed(ran({exitCode: 1}))});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).commandExit).toBe(1);
	});

	it("records a run that hung rather than losing it", async () => {
		const {outcome} = await run({
			spawn: () => Effect.succeed(ran({exitCode: null, timedOut: true})),
		});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toMatchObject({commandExit: null, timedOut: true});
	});

	it("records the truncation rather than letting it be silent", async () => {
		const {outcome} = await run({spawn: () => Effect.succeed(ran({truncated: true}))});
		expect(JSON.parse(outcome.stdout).truncated).toBe(true);
	});

	it("writes the capture files BEFORE the record, so no record names a missing file", async () => {
		const {written} = await run();
		const paths = [...written.keys()];
		expect(paths).toContain(`${WORKSPACE}/runs/1.out`);
		expect(paths).toContain(`${WORKSPACE}/runs/1.err`);
		expect(paths.indexOf(EVIDENCE)).toBeGreaterThan(paths.indexOf(`${WORKSPACE}/runs/1.err`));
	});

	it("derives seq from the line count of an existing log", async () => {
		const {outcome} = await run({}, {...resident, files: {...resident.files, [EVIDENCE]: ONE_RUN}});
		expect(JSON.parse(outcome.stdout).seq).toBe(2);
	});

	it("appends a line that parses back as the record it answered", async () => {
		const {written} = await run();
		const parsed = parseEvidence(written.get(EVIDENCE) ?? "");
		expect(parsed).toEqual({_tag: "Parsed", value: [evidenceRecord(1)]});
	});
});

describe("runRun never fuses `could not run` with `ran and answered no`", () => {
	it("seats an unstartable command on 11 with nothing appended", async () => {
		const {outcome, written} = await run({
			spawn: () => Effect.succeed({_tag: "Unstartable" as const, reason: "ENOENT"}),
		});
		expect(outcome.code).toBe(READ_OR_EXEC_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("NOT an answer of no");
		expect(written.size).toBe(0);
	});

	it("seats a capture file that could not be written on 11 with nothing appended", async () => {
		const {outcome, written} = await run(
			{},
			{...resident, unwritable: [`${WORKSPACE}/runs/1.out`]},
		);
		expect(outcome.code).toBe(READ_OR_EXEC_UNKNOWN);
		expect(written.has(EVIDENCE)).toBe(false);
	});
});

describe("runRun refuses on the workspace before it spawns anything", () => {
	it("seats an absent workspace on 12", async () => {
		const {outcome, requests} = await run({}, {});
		expect(outcome.code).toBe(NO_WORKSPACE);
		expect(requests).toHaveLength(0);
	});

	it("seats a manifest that does not parse on 4", async () => {
		const {outcome} = await run({}, {directories: [WORKSPACE], files: {[MANIFEST]: "{}\n"}});
		expect(outcome.code).toBe(MALFORMED_RECORD);
	});

	it("seats a log that does not parse on 4", async () => {
		const {outcome} = await run(
			{},
			{...resident, files: {...resident.files, [EVIDENCE]: "nope\n"}},
		);
		expect(outcome.code).toBe(MALFORMED_RECORD);
	});

	it("seats a log whose seq values are not contiguous on 4", async () => {
		const {outcome} = await run(
			{},
			{...resident, files: {...resident.files, [EVIDENCE]: evidenceText([evidenceRecord(2)])}},
		);
		expect(outcome.code).toBe(MALFORMED_RECORD);
	});

	it("seats a workspace that resolves inside the tree on 13", async () => {
		const {outcome, requests} = await run(
			{},
			{
				directories: [WORKSPACE],
				files: {[MANIFEST]: manifestText({treeRoot: TMP_ROOT})},
			},
		);
		expect(outcome.code).toBe(WORKSPACE_IN_TREE);
		expect(requests).toHaveLength(0);
	});

	it("treats an absent log as a fact — seq 1, not a refusal", async () => {
		const {outcome} = await run();
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).seq).toBe(1);
	});
});

describe("runRun refuses off-vocabulary values on 10", () => {
	it.each([
		["a non-positive --timeout", {timeout: 0}],
		["a malformed --env pair", {env: ["not-a-pair"]}],
		["an --env pair naming a credential", {env: ["ACME_TOKEN=secret"]}],
		["an off-grammar --nonce", {nonce: "run-1"}],
	])("refuses %s", async (_case, override) => {
		const {outcome, requests} = await run(override as Partial<typeof options>);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stdout).toBe("");
		expect(requests).toHaveLength(0);
	});
});

describe("the child's environment is built, never inherited", () => {
	it("passes through only the six named variables plus SPIKE_WORKSPACE", async () => {
		const {requests} = await run();
		expect(requests[0]?.env).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/agent",
			SPIKE_WORKSPACE: WORKSPACE,
		});
	});

	it("runs the child in the workspace", async () => {
		const {requests} = await run();
		expect(requests[0]?.cwd).toBe(WORKSPACE);
	});

	it("classifies a credential by shape, never by a named list that goes stale", () => {
		expect(isCredentialName("GH_TOKEN")).toBe(true);
		expect(isCredentialName("SOME_FUTURE_SECRET")).toBe(true);
		expect(isCredentialName("ANY_API_KEY")).toBe(true);
		expect(isCredentialName("PATH")).toBe(false);
	});

	it("refuses a credential named explicitly rather than honouring it", () => {
		expect(
			childEnv({parentEnv: {}, pairs: ["GITHUB_TOKEN=x"], workspace: WORKSPACE}),
		).toMatchObject({_tag: "Refused"});
	});
});
