import {Effect, FileSystem, Layer, Path, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {fakeSeams, type HttpReply, once, type Scripted} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {
	EMPTY_STDIN,
	INVALID_CAPTURE,
	MALFORMED_DOCUMENT,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	STALE_TREE,
	UPLOAD_FAILED,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {type CaptureManifest, serializeManifest, sha256Hex} from "./manifest.ts";
import {runPost, type UploadLeg} from "./post-verb.ts";
import {classifyProbe} from "./upload-leg.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const OLD_HEAD = "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192";
const SET_DIR = "/tmp/fabrika-review-ui/4321-03135b91/judged";
const CAPTURE_PATH = `${SET_DIR}/pano.png`;
const MANIFEST_PATH = `${SET_DIR}/manifest.json`;
const HARNESS = "/repo/design-harness.json";
const HOSTED = "https://github.com/user-attachments/assets/9c41";
const URL = "https://example.test/pull/4321#issuecomment-5154902211";

const BYTES = new TextEncoder().encode("png bytes");

const manifest = (overrides: Partial<CaptureManifest> = {}): CaptureManifest => ({
	set: "judged",
	pr: 4321,
	head: HEAD,
	previewUrl: "https://pr-4321.example.test",
	captures: [
		{
			surface: "/pano",
			path: CAPTURE_PATH,
			width: 1280,
			height: 2140,
			sha256: sha256Hex(BYTES),
			pageErrors: {rows: [], more: 0},
		},
	],
	...overrides,
});

interface FsShape {
	readonly strings?: Readonly<Record<string, string>>;
	readonly bytes?: Readonly<Record<string, Uint8Array>>;
}

const notFound = (method: string, path: string) =>
	Effect.fail(
		PlatformError.systemError({
			_tag: "NotFound",
			module: "FileSystem",
			method,
			pathOrDescriptor: path,
		}),
	);

/** A filesystem that can serve BYTES as well as text — a capture is not UTF-8. */
const fs = (shape: FsShape): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
	Layer.merge(
		FileSystem.layerNoop({
			readFileString: (path: string) => {
				const text = shape.strings?.[path];
				return text === undefined ? notFound("readFileString", path) : Effect.succeed(text);
			},
			readFile: (path: string) => {
				const bytes = shape.bytes?.[path];
				return bytes === undefined ? notFound("readFile", path) : Effect.succeed(bytes);
			},
			exists: (path: string) => Effect.succeed(shape.strings?.[path] !== undefined),
		}),
		Path.layer,
	);

const world = (overrides: FsShape = {}): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
	fs({
		strings: {[MANIFEST_PATH]: serializeManifest(manifest()), ...overrides.strings},
		bytes: {[CAPTURE_PATH]: BYTES, ...overrides.bytes},
	});

const PULL = /GET .*\/repos\/o\/r\/pulls\/4321\b/;
const USER = /GET .*api\.github\.com\/user$/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4321\/comments/;
const CREATE = /POST .*\/repos\/o\/r\/issues\/4321\/comments/;
const PATCH = /PATCH .*\/repos\/o\/r\/issues\/comments\/\d+/;
const READBACK = /GET .*\/repos\/o\/r\/issues\/comments\/\d+/;

const pull = (state = "open", head = HEAD): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4321,
		state,
		head: {sha: head},
		base: {ref: "main"},
		body: "",
		changed_files: 1,
		comments: 0,
	}),
});

const comments = (
	...rows: ReadonlyArray<{id: number; body: string; author?: string; updatedAt?: string}>
): HttpReply => ({
	status: 200,
	body: JSON.stringify(
		rows.map((row) => ({
			id: row.id,
			user: {login: row.author ?? "kampus-bot"},
			created_at: "2026-08-08T00:00:00Z",
			updated_at: row.updatedAt ?? "2026-08-08T00:00:00Z",
			body: row.body,
		})),
	),
});

const hostingLeg: UploadLeg = () => Effect.succeed({_tag: "Hosted", url: HOSTED});
const failingLeg: UploadLeg = () => Effect.succeed({_tag: "Failed", reason: "HTTP 500"});

const BODY = "| surface | verdict |\n|---|---|\n| /pano | FAIL |\n";

const options = {
	pr: 4321,
	polarity: "FAIL",
	sha: HEAD,
	clause: "changes-requested",
	evidence: "judged",
	carrier: "marker",
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	stdin: Effect.succeed<StdinRead>({_tag: "Text", text: BODY}),
	tmpRoot: "/tmp",
	harnessPath: HARNESS,
	upload: hostingLeg,
};

/** The comment as the verb will have posted it, echoed back by the read-back read. */
const posted = (body: string): HttpReply => ({status: 200, body: JSON.stringify({body})});

const run = (
	script: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
	layer: Layer.Layer<FileSystem.FileSystem | Path.Path> = world(),
) => {
	const seams = fakeSeams(script);
	return Effect.runPromise(
		Effect.provide(runPost({...options, ...overrides}), Layer.merge(seams.layer, layer)),
	).then((outcome) => ({outcome, requests: seams.requests, bodies: seams.bodies}));
};

const COMPOSED = `review-ui: FAIL @ ${HEAD} — changes-requested\n\n${BODY.trimEnd()}\n\n## Evidence\n\n### /pano\n\n![/pano](${HOSTED})`;

const happy = (): ReadonlyArray<Scripted> => [
	[PULL, pull()],
	[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
	[COMMENTS, comments()],
	[CREATE, {status: 201, body: JSON.stringify({id: 5154902211, html_url: URL})}],
	[READBACK, posted(COMPOSED)],
];

describe("runPost", () => {
	it("posts one marker-first comment with the verified evidence gallery under it", async () => {
		const {outcome, requests, bodies} = await run(happy());
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			answer: "posted",
			namespace: "review-ui",
			polarity: "FAIL",
			sha: HEAD,
			upsert: "created",
			carrier: "marker",
			surfaces: 1,
			commentUrl: URL,
		});
		const write = bodies[requests.findIndex((request) => CREATE.test(request))] ?? "";
		const body = String(JSON.parse(write).body);
		expect(body.split("\n")[0]).toBe(`review-ui: FAIL @ ${HEAD} — changes-requested`);
		expect(body).toContain(`![/pano](${HOSTED})`);
		// The gallery embeds the hosted URL, never the local path the reviewer judged.
		expect(body).not.toContain(CAPTURE_PATH);
	});

	it("refuses an empty verdict body on 3 — an empty verdict reads as ungated", async () => {
		const {outcome} = await run(happy(), {
			stdin: Effect.succeed<StdinRead>({_tag: "NoStdin", reason: "nothing was piped in"}),
		});
		expect(outcome.code).toBe(EMPTY_STDIN);
	});

	it("refuses a bad polarity, a bad carrier, and advisory+FAIL on 10", async () => {
		expect((await run(happy(), {polarity: "MAYBE"})).outcome.code).toBe(OFF_VOCABULARY);
		expect((await run(happy(), {carrier: "letter"})).outcome.code).toBe(OFF_VOCABULARY);
		expect((await run(happy(), {carrier: "advisory"})).outcome.code).toBe(OFF_VOCABULARY);
	});

	it("refuses a closed PR on 7", async () => {
		const {outcome} = await run([[PULL, pull("closed")], ...happy().slice(1)]);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("refuses on 12 when the live head moved past --sha, and posts nothing", async () => {
		const {outcome, requests} = await run([[PULL, pull("open", OLD_HEAD)], ...happy().slice(1)]);
		expect(outcome.code).toBe(STALE_TREE);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("refuses on 12 when the evidence set was rendered at another head", async () => {
		const {outcome} = await run(
			happy(),
			{},
			world({strings: {[MANIFEST_PATH]: serializeManifest(manifest({head: OLD_HEAD}))}}),
		);
		expect(outcome.code).toBe(STALE_TREE);
	});

	it("refuses on 4 when the set has no readable manifest — a set without one is not a set", async () => {
		const absent = await run(happy(), {}, fs({bytes: {[CAPTURE_PATH]: BYTES}}));
		expect(absent.outcome.code).toBe(MALFORMED_DOCUMENT);
		const unparseable = await run(happy(), {}, world({strings: {[MANIFEST_PATH]: "{"}}));
		expect(unparseable.outcome.code).toBe(MALFORMED_DOCUMENT);
	});

	it("refuses on 4 when design-harness.json exists but violates its schema", async () => {
		const {outcome} = await run(happy(), {}, world({strings: {[HARNESS]: '{"evidenceStore":{}}'}}));
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
	});

	it("refuses on 15 when a capture no longer matches its manifest sha", async () => {
		const {outcome} = await run(
			happy(),
			{},
			world({bytes: {[CAPTURE_PATH]: new TextEncoder().encode("other bytes")}}),
		);
		expect(outcome.code).toBe(INVALID_CAPTURE);
	});

	it("keeps an unreadable capture UNKNOWN (11) rather than calling it invalid", async () => {
		const {outcome} = await run(
			happy(),
			{},
			fs({strings: {[MANIFEST_PATH]: serializeManifest(manifest())}}),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("posts NOTHING when an evidence upload fails — 17 is this verb's reason to exist", async () => {
		const {outcome, requests} = await run(happy(), {upload: failingLeg});
		expect(outcome.code).toBe(UPLOAD_FAILED);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
		expect(outcome.stderr.at(-1)).toMatch(/broken evidence channel/);
	});

	it("still refuses when the AUTHENTICATED probe reads 404 — #6520 does not soften #3925", async () => {
		const notResolving: UploadLeg = () =>
			Effect.succeed({_tag: "Failed", reason: classifyProbe(404) ?? ""});
		const {outcome, requests} = await run(happy(), {upload: notResolving});
		expect(outcome.code).toBe(UPLOAD_FAILED);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
		expect(outcome.stderr.join("\n")).toMatch(/probed back HTTP 404/);
	});

	it("edits this namespace's own comment instead of stacking a second marker", async () => {
		const {outcome, requests} = await run([
			[PULL, pull()],
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[
				COMMENTS,
				comments({
					id: 42,
					body: `review-ui: PASS @ ${OLD_HEAD} — older round`,
					author: "kampus-bot",
				}),
			],
			[PATCH, {status: 200, body: JSON.stringify({html_url: URL})}],
			[READBACK, posted(COMPOSED)],
		]);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).upsert).toBe("edited");
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("edits the NEWEST of two markers at one SHA, not whichever came back first (#4881)", async () => {
		const {outcome, requests} = await run([
			[PULL, pull()],
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[
				COMMENTS,
				comments(
					{
						id: 41,
						body: `review-ui: FAIL @ ${HEAD} — first round`,
						updatedAt: "2026-08-09T09:56:43Z",
					},
					{
						id: 42,
						body: `review-ui: PASS @ ${HEAD} — after the body-only repair`,
						updatedAt: "2026-08-09T10:10:48Z",
					},
				),
			],
			[PATCH, {status: 200, body: JSON.stringify({html_url: URL})}],
			[READBACK, posted(COMPOSED)],
		]);
		expect(outcome.code).toBe(0);
		expect(requests.find((request) => PATCH.test(request))).toContain("issues/comments/42");
	});

	it("refuses on 8 when the write itself failed — UNKNOWN, never 1", async () => {
		const {outcome} = await run([
			[PULL, pull()],
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[COMMENTS, comments()],
			[CREATE, {status: 502, body: "{}"}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
	});

	it("refuses on 9 when the read-back does not yield this marker", async () => {
		const {outcome} = await run([
			[PULL, pull()],
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[COMMENTS, comments()],
			[CREATE, {status: 201, body: JSON.stringify({id: 1, html_url: URL})}],
			[once(READBACK), posted("someone else's comment entirely")],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});
