import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	errOut,
	type FakeFsOptions,
	fakeFs,
	fakeSeams,
	okOut,
	type Scripted,
} from "../fakes.test-support.ts";
import {issueBody, spikeTitle} from "./bodies.ts";
import {
	MALFORMED_RECORD,
	MANIFEST_INCOMPLETE,
	NO_WORKSPACE,
	OFF_VOCABULARY,
	READ_OR_EXEC_UNKNOWN,
	READBACK_MISMATCH,
	WORKSPACE_IN_TREE,
	WORKSPACE_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	CLEAN_TREE_DIGEST,
	CREATE,
	ENV,
	ISSUE,
	issuePayload,
	issueRowsPayload,
	LABELS,
	labelsPayload,
	MANIFEST,
	manifestText,
	NONCE,
	OPEN_SPIKES,
	QUESTION,
	ROOT,
	SPIKE,
	STATUS,
	TMP_ROOT,
	TREE_ROOT,
	WORKSPACE,
} from "./fixtures.test-support.ts";
import {runOpen} from "./open-verb.ts";
import {parseManifest} from "./workspace.ts";

const BODY = issueBody({question: QUESTION, kind: "logic", nonce: NONCE, ticket: null});
const TITLE = spikeTitle(QUESTION);

const options = {
	question: QUESTION,
	kind: "logic",
	ticket: null,
	nonce: null as string | null,
	repo: null as string | null,
	env: ENV,
	tmpRoot: TMP_ROOT,
	mintNonce: () => NONCE,
};

const happy: ReadonlyArray<Scripted> = [
	[ROOT, okOut(`${TREE_ROOT}\n`)],
	[LABELS, {status: 200, body: labelsPayload("prototyping:spike", "type:bug")}],
	[STATUS, okOut("")],
	[
		CREATE,
		{status: 201, body: JSON.stringify({number: SPIKE, html_url: "https://example.test/#9310"})},
	],
	[ISSUE, {status: 200, body: issuePayload({title: TITLE, body: BODY})}],
];

const run = (
	script: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
	fs: FakeFsOptions = {},
) => {
	const disk = fakeFs(fs);
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(runOpen({...options, ...overrides}), Layer.merge(disk.layer, seams.layer)),
	).then((outcome) => ({
		outcome,
		written: disk.written,
		requests: seams.requests,
		bodies: seams.bodies,
	}));
};

describe("runOpen mints a spike, its workspace and their binding", () => {
	it("answers the issue number, the nonce, the workspace and the tree digest", async () => {
		const {outcome} = await run(happy);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			spike: SPIKE,
			nonce: NONCE,
			kind: "logic",
			workspace: WORKSPACE,
			treeDigest: CLEAN_TREE_DIGEST,
		});
	});

	it("creates the workspace BEFORE the issue, so a half-run leaves a collectable orphan", async () => {
		const {written, requests} = await run(happy);
		expect([...written.keys()]).toContain(MANIFEST);
		expect(requests.filter((line) => CREATE.test(line))).toHaveLength(1);
	});

	it("sends the label in the create request itself, so there is no unlabelled window", async () => {
		const {requests, bodies} = await run(happy);
		expect(bodies[requests.findIndex((line) => CREATE.test(line))]).toContain(
			'"labels":["prototyping:spike"]',
		);
	});

	it("completes the manifest with the spike number", async () => {
		const {written} = await run(happy);
		const parsed = parseManifest(written.get(MANIFEST) ?? "");
		expect(parsed._tag === "Parsed" ? parsed.value.spike : null).toBe(SPIKE);
	});
});

describe("runOpen refuses before it writes anything", () => {
	it("refuses an off-vocabulary --kind on 10", async () => {
		const {outcome, written} = await run(happy, {kind: "prototype"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
	});

	it("refuses an off-grammar --nonce on 10", async () => {
		const {outcome, written} = await run(happy, {nonce: "run-1"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.join("\n")).toContain("minted by this verb");
		expect(written.size).toBe(0);
	});

	it("refuses a workspace inside the repository on 13, with nothing written", async () => {
		const {outcome, written} = await run(happy, {tmpRoot: "/repo/tmp"});
		expect(outcome.code).toBe(WORKSPACE_IN_TREE);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
	});

	it("refuses a proven-absent label on 7 and names the bootstrap", async () => {
		const {outcome, written} = await run([
			[ROOT, okOut(`${TREE_ROOT}\n`)],
			[LABELS, {status: 200, body: labelsPayload("type:bug")}],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("front-door");
		expect(written.size).toBe(0);
	});

	it("refuses an unreadable label set on 11 — never as a proven absence", async () => {
		const {outcome} = await run([
			[ROOT, okOut(`${TREE_ROOT}\n`)],
			[LABELS, {status: 502, body: "{}"}],
		]);
		expect(outcome.code).toBe(READ_OR_EXEC_UNKNOWN);
		expect(outcome.stderr.join("\n")).not.toContain("front-door");
	});

	it("refuses an unreadable tree on 11 — an unreadable tree is never clean", async () => {
		const {outcome, written} = await run([
			[ROOT, okOut(`${TREE_ROOT}\n`)],
			[LABELS, {status: 200, body: labelsPayload("prototyping:spike")}],
			[STATUS, errOut("fatal: not a git repository")],
		]);
		expect(outcome.code).toBe(READ_OR_EXEC_UNKNOWN);
		expect(written.size).toBe(0);
	});

	it("refuses --nonce naming no workspace on 12", async () => {
		const {outcome} = await run(happy, {nonce: "0badf00d"});
		expect(outcome.code).toBe(NO_WORKSPACE);
		expect(outcome.stderr.join("\n")).toContain("omit it to mint a new run");
	});
});

describe("runOpen re-enters an existing workspace rather than minting a second issue", () => {
	const resident: FakeFsOptions = {directories: [WORKSPACE], files: {[MANIFEST]: manifestText()}};

	it("answers the existing manifest and creates nothing", async () => {
		const {outcome, requests} = await run(happy, {nonce: NONCE}, resident);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).spike).toBe(SPIKE);
		expect(requests.filter((line) => CREATE.test(line))).toHaveLength(0);
	});

	it("refuses a workspace holding a different question on 18", async () => {
		const {outcome} = await run(
			happy,
			{nonce: NONCE, question: "something else entirely"},
			resident,
		);
		expect(outcome.code).toBe(WORKSPACE_MISMATCH);
	});

	it("refuses a workspace holding a different kind on 18", async () => {
		const {outcome} = await run(happy, {nonce: NONCE, kind: "ui"}, resident);
		expect(outcome.code).toBe(WORKSPACE_MISMATCH);
	});

	it("refuses a manifest that does not parse on 4, whole-file", async () => {
		const {outcome} = await run(
			happy,
			{nonce: NONCE},
			{
				directories: [WORKSPACE],
				files: {[MANIFEST]: "{}\n"},
			},
		);
		expect(outcome.code).toBe(MALFORMED_RECORD);
		expect(outcome.stderr.join("\n")).toContain("refusing the whole file");
	});

	it("completes a provisional manifest from the open spike whose body names this nonce", async () => {
		const {outcome, written} = await run(
			[
				[ROOT, okOut(`${TREE_ROOT}\n`)],
				[OPEN_SPIKES, {status: 200, body: issueRowsPayload([{number: SPIKE, title: TITLE}])}],
				[ISSUE, {status: 200, body: issuePayload({title: TITLE, body: BODY})}],
			],
			{nonce: NONCE},
			{directories: [WORKSPACE], files: {[MANIFEST]: manifestText({spike: null})}},
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).spike).toBe(SPIKE);
		expect(parseManifest(written.get(MANIFEST) ?? "")).toMatchObject({
			_tag: "Parsed",
			value: {spike: SPIKE},
		});
	});

	it("refuses an unreadable open-spike listing on 11, leaving the manifest provisional", async () => {
		const {outcome, written} = await run(
			[
				[ROOT, okOut(`${TREE_ROOT}\n`)],
				[OPEN_SPIKES, {status: 502, body: "{}"}],
			],
			{nonce: NONCE},
			{directories: [WORKSPACE], files: {[MANIFEST]: manifestText({spike: null})}},
		);
		expect(outcome.code).toBe(READ_OR_EXEC_UNKNOWN);
		expect(written.size).toBe(0);
	});
});

describe("runOpen proves the issue landed as sent", () => {
	it("seats an unproven create on 8", async () => {
		const {outcome} = await run([
			[ROOT, okOut(`${TREE_ROOT}\n`)],
			[LABELS, {status: 200, body: labelsPayload("prototyping:spike")}],
			[STATUS, okOut("")],
			[CREATE, {status: 502, body: "{}"}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
		expect(outcome.stderr.join("\n")).toContain("may or may not have landed");
	});

	it("seats a body that does not read back as sent on 9", async () => {
		const {outcome} = await run([
			...happy.filter(([pattern]) => pattern !== ISSUE),
			[ISSUE, {status: 200, body: issuePayload({title: TITLE, body: "somebody edited it"})}],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stderr.join("\n")).toContain("body");
	});

	it("seats a label that did not land on 9", async () => {
		const {outcome} = await run([
			...happy.filter(([pattern]) => pattern !== ISSUE),
			[ISSUE, {status: 200, body: issuePayload({title: TITLE, body: BODY, labels: []})}],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
		expect(outcome.stderr.join("\n")).toContain("labels");
	});

	it("seats a manifest that could not be completed on 20, naming both halves", async () => {
		const {outcome} = await run(
			[
				[ROOT, okOut(`${TREE_ROOT}\n`)],
				[OPEN_SPIKES, {status: 200, body: issueRowsPayload([{number: SPIKE, title: TITLE}])}],
				[ISSUE, {status: 200, body: issuePayload({title: TITLE, body: BODY})}],
			],
			{nonce: NONCE},
			{
				directories: [WORKSPACE],
				files: {[MANIFEST]: manifestText({spike: null})},
				unwritable: [MANIFEST],
			},
		);
		expect(outcome.code).toBe(MANIFEST_INCOMPLETE);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(`#${SPIKE}`);
		expect(outcome.stderr.join("\n")).toContain(`--nonce ${NONCE}`);
	});
});
