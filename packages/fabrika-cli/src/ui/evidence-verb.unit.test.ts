import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	comments,
	GIT_DIRS,
	HEAD,
	issue,
	LANE_UUID,
	marker,
	NONCE,
	pull,
} from "../build/fixtures.test-support.ts";
import {fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
import {isBareAtReference} from "../report/leaks.ts";
import {
	BAD_SECTIONS,
	CAPTURE_INVALID,
	LANE_NOT_MINE,
	LEAKED_PATH,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	UPLOAD_FAILED,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	composeEvidence,
	type EvidenceOptions,
	runEvidence,
	type Upload,
	type UploadTarget,
} from "./evidence-verb.ts";
import {encodePng, type FakeBytesFsOptions, fakeBytesFs, solid} from "./fakes.test-support.ts";
import {sha256Of} from "./png.ts";
import {pairSets, parseSetManifest} from "./set-manifest.ts";

const LANE = `build/4312-editor-focus-loss-${NONCE}`;
const SCRATCH = `/tmp/fabrika-build/s-9f2e/4312-${NONCE}`;
const PNG = encodePng(2, 2, solid(2, 2, [0, 0, 0, 255]));
const SHA = sha256Of(PNG);

const setManifest = (set: string, rows: ReadonlyArray<{surface: string; firstRender?: boolean}>) =>
	JSON.stringify({
		set,
		captures: rows.map((row) => ({
			surface: row.surface,
			path: `${SCRATCH}/${set}/${row.surface.replace(/^\//, "")}.png`,
			width: 2,
			height: 2,
			sha256: SHA,
			firstRender: row.firstRender === true,
		})),
	});

const files = (): Record<string, Uint8Array | string> => ({
	[`${SCRATCH}/before/manifest.json`]: setManifest("before", [{surface: "/pano"}]),
	[`${SCRATCH}/before/pano.png`]: PNG,
	[`${SCRATCH}/after/manifest.json`]: setManifest("after", [{surface: "/pano"}]),
	[`${SCRATCH}/after/pano.png`]: PNG,
});

const POSTED_ID = 512347;

// One `pulls/4318` row answers both reads over that resource: the PR record and the head branch the
// lane fence compares against.
const script = (overrides: ReadonlyArray<Scripted> = []): ReadonlyArray<Scripted> => [
	...overrides,
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	[/^git rev-parse --abbrev-ref HEAD$/, okOut(`${LANE}\n`)],
	[/GET .*\/repos\/o\/r\/issues\/4312$/, issue()],
	[
		/GET .*\/repos\/o\/r\/issues\/4312\/comments/,
		comments({id: 1, body: marker("s-9f2e", LANE_UUID)}),
	],
	[
		/GET .*\/repos\/o\/r\/collaborators\/agent\/permission/,
		{status: 200, body: '{"permission":"write"}'},
	],
	[/GET .*\/repos\/o\/r\/pulls\/4318$/, pull({head: {sha: HEAD, ref: LANE}})],
	[
		/POST .*\/repos\/o\/r\/issues\/4318\/comments/,
		{
			status: 201,
			body: JSON.stringify({
				id: POSTED_ID,
				html_url: "https://github.com/o/r/pull/4318#issuecomment-1",
			}),
		},
	],
];

const uploads: Pick<EvidenceOptions, "storeUpload" | "attachmentUpload"> = {
	storeUpload: (_store: string, target: UploadTarget): Effect.Effect<Upload> =>
		Effect.succeed({_tag: "Ok", url: `https://depo.example/${target.role}${target.surface}.png`}),
	attachmentUpload: (_repo: string, target: UploadTarget): Effect.Effect<Upload> =>
		Effect.succeed({
			_tag: "Ok",
			url: `https://github.com/user-attachments/assets/${target.role}${target.surface}`,
		}),
};

const options: EvidenceOptions = {
	pr: 4318,
	before: "before",
	after: "after",
	repo: null,
	env: {
		CLAUDE_PIPELINE_REPO: "o/r",
		CLAUDE_CODE_SESSION_ID: "s-9f2e",
		GITHUB_TOKEN: "ghp_scripted",
	},
	tmpRoot: "/tmp",
	...uploads,
};

/** The read-back the happy path needs: the posted body, echoed. */
const withReadback = (
	rows: ReadonlyArray<Scripted>,
	body: () => string,
): ReadonlyArray<Scripted> => [
	[
		/GET .*\/repos\/o\/r\/issues\/comments\/512347$/,
		{status: 200, body: JSON.stringify({body: body()})},
	],
	...rows,
];

const EXPECTED_BODY = composeEvidence(
	[
		{
			surface: "/pano",
			before: "https://github.com/user-attachments/assets/before/pano",
			after: "https://github.com/user-attachments/assets/after/pano",
		},
	],
	HEAD,
);

const run = (
	rows: ReadonlyArray<Scripted>,
	fs: FakeBytesFsOptions,
	overrides: Partial<EvidenceOptions> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runEvidence({...options, ...overrides}),
			Layer.mergeAll(fakeSeams(rows).layer, fakeBytesFs(fs).layer),
		),
	);

describe("parseSetManifest", () => {
	it("refuses a manifest that names zero captures", () => {
		expect(parseSetManifest('{"set":"after","captures":[]}')).toEqual({
			_tag: "Violation",
			violation: "it names zero captures",
		});
	});
});

describe("pairSets", () => {
	it("pairs by surface id and labels a firstRender surface as new", () => {
		const before = [{surface: "/pano", path: "b", sha256: SHA, firstRender: false}];
		const after = [
			{surface: "/pano", path: "a", sha256: SHA, firstRender: false},
			{surface: "/yeni", path: "y", sha256: SHA, firstRender: true},
		];
		const paired = pairSets(before, after);
		expect(paired).toEqual({
			_tag: "Pairs",
			pairs: [
				{surface: "/pano", before: before[0], after: after[0]},
				{surface: "/yeni", before: null, after: after[1]},
			],
		});
	});

	it("refuses an after-surface with neither a before nor a firstRender mark", () => {
		expect(pairSets([], [{surface: "/pano", path: "a", sha256: SHA, firstRender: false}])).toEqual({
			_tag: "Unexplained",
			surface: "/pano",
		});
	});
});

describe("runEvidence", () => {
	it("uploads, posts one head-bound comment, and reads it back", async () => {
		const outcome = await run(
			withReadback(script(), () => EXPECTED_BODY),
			{files: files()},
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "attached",
			pr: 4318,
			commentId: POSTED_ID,
			head: HEAD,
			surfaces: 1,
		});
		expect(EXPECTED_BODY).toContain(HEAD);
	});

	it("refuses on 17 with NOTHING posted when one upload fails", async () => {
		const seams = fakeSeams(withReadback(script(), () => EXPECTED_BODY));
		const outcome = await Effect.runPromise(
			Effect.provide(
				runEvidence({
					...options,
					attachmentUpload: (_repo, target) =>
						Effect.succeed(
							target.role === "before"
								? {_tag: "Failed", reason: "HTTP 502"}
								: {_tag: "Ok", url: "https://github.com/user-attachments/assets/x"},
						),
				}),
				Layer.mergeAll(seams.layer, fakeBytesFs({files: files()}).layer),
			),
		);
		expect(outcome.code).toBe(UPLOAD_FAILED);
		expect(outcome.stdout).toBe("");
		expect(seams.requests.some((line) => line.startsWith("POST"))).toBe(false);
	});

	it("refuses an after-surface with no baseline on 4", async () => {
		const outcome = await run(
			script(),
			{
				files: {
					[`${SCRATCH}/after/manifest.json`]: setManifest("after", [{surface: "/pano"}]),
					[`${SCRATCH}/after/pano.png`]: PNG,
				},
			},
			{before: null},
		);
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stderr.at(-1)).toContain("an unexplained missing baseline");
	});

	it("refuses a set with no manifest.json on 4", async () => {
		const outcome = await run(script(), {files: {}});
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stderr.at(-1)).toContain("a set without its manifest is not a set");
	});

	it("refuses a closed PR on 7", async () => {
		const outcome = await run(
			script([
				[
					/GET .*\/repos\/o\/r\/pulls\/4318$/,
					pull({state: "closed", head: {sha: HEAD, ref: LANE}}),
				],
			]),
			{files: files()},
		);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("refuses another lane's PR on 18 — an evidence comment there is a cross-lane write", async () => {
		const outcome = await run(
			script([
				[
					/GET .*\/repos\/o\/r\/pulls\/4318$/,
					pull({head: {sha: HEAD, ref: "build/9999-other-aaaaaaaa"}}),
				],
			]),
			{files: files()},
		);
		expect(outcome.code).toBe(LANE_NOT_MINE);
	});

	it("refuses a foreign claim on 18", async () => {
		const outcome = await run(
			script([
				[
					/GET .*\/repos\/o\/r\/issues\/4312\/comments/,
					comments({id: 1, body: marker("other-session", LANE_UUID)}),
				],
			]),
			{files: files()},
		);
		expect(outcome.code).toBe(LANE_NOT_MINE);
	});

	it("refuses on 8 when the post itself fails — it may or may not have landed", async () => {
		const outcome = await run(
			script([[/POST .*\/repos\/o\/r\/issues\/4318\/comments/, {status: 502, body: "{}"}]]),
			{files: files()},
		);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
	});

	it("refuses on 9 when the comment does not read back as sent", async () => {
		const outcome = await run(
			withReadback(script(), () => "something else entirely"),
			{
				files: files(),
			},
		);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});

	it("refuses on 11 when a capture cannot be read", async () => {
		const withoutPng = files();
		delete withoutPng[`${SCRATCH}/after/pano.png`];
		const outcome = await run(script(), {files: withoutPng});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("nothing was uploaded or posted");
	});

	it("refuses on 16 when a capture no longer hashes to its manifest sha256, uploading nothing", async () => {
		const tampered = files();
		tampered[`${SCRATCH}/after/pano.png`] = encodePng(2, 2, solid(2, 2, [255, 0, 0, 255]));
		const uploaded: string[] = [];
		const seams = fakeSeams(script());
		const outcome = await Effect.runPromise(
			Effect.provide(
				runEvidence({
					...options,
					attachmentUpload: (_repo, target) => {
						uploaded.push(target.fileName);
						return Effect.succeed<Upload>({
							_tag: "Ok",
							url: "https://github.com/user-attachments/assets/x",
						});
					},
				}),
				Layer.mergeAll(seams.layer, fakeBytesFs({files: tampered}).layer),
			),
		);
		expect(outcome.code).toBe(CAPTURE_INVALID);
		expect(uploaded).toEqual([]);
		expect(seams.requests.some((line) => line.startsWith("POST"))).toBe(false);
	});

	it("refuses a machine-local path in the composed comment on 5, and posts nothing", async () => {
		const seams = fakeSeams(script());
		const outcome = await Effect.runPromise(
			Effect.provide(
				runEvidence({
					...options,
					attachmentUpload: (_repo, target) =>
						Effect.succeed<Upload>({
							_tag: "Ok",
							url: `/Users/someone/captures/${target.fileName}`,
						}),
				}),
				Layer.mergeAll(seams.layer, fakeBytesFs({files: files()}).layer),
			),
		);
		expect(outcome.code).toBe(LEAKED_PATH);
		expect(outcome.stdout).toBe("");
		expect(seams.requests.some((line) => line.startsWith("POST"))).toBe(false);
	});

	// Seat 6 is the #3086 backstop, and `runEvidence` cannot reach it: `composeEvidence` always leads
	// with its own `**UI evidence**` header, so the composed body's first token is never an `@` path —
	// including when an upload leg hands back an `@` path in place of a URL. What is testable, and
	// what this pins, is that the predicate the seat rides on refuses the #3086 body while no body the
	// verb composes trips it. Whether the seat should move onto each upload URL instead is #5170.
	it("keeps the composed comment out of seat 6's bare @ path refusal", () => {
		expect(isBareAtReference("@/tmp/ui-evidence.md")).toBe(true);
		expect(isBareAtReference(EXPECTED_BODY)).toBe(false);
		expect(
			isBareAtReference(
				composeEvidence([{surface: "/pano", before: null, after: "@/tmp/after-pano.png"}], HEAD),
			),
		).toBe(false);
	});
});
