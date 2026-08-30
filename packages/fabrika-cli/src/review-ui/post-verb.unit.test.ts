import {Effect, FileSystem, Layer, Path, PlatformError} from "effect";
import {describe, expect, it} from "vitest";
import {
	fakeSeams,
	type HttpReply,
	once,
	type Scripted,
	unconfigured,
} from "../fakes.test-support.ts";
import {ok} from "../io/git.ts";
import type {StdinRead} from "../io/stdin.ts";
import {runGate} from "../ship/gate-verb.ts";
import {read as readMarker} from "../wire/verdict-marker.ts";
import {
	EMPTY_STDIN,
	INVALID_CAPTURE,
	MALFORMED_DOCUMENT,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	RENDER_CRASHED,
	STALE_TREE,
	UPLOAD_FAILED,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	CI_PROVENANCE_RECEIPT,
	type CiCaptureManifest,
	declarationDigest,
} from "./localhost-evidence.ts";
import {type CaptureManifest, serializeManifest, sha256Hex} from "./manifest.ts";
import {runPost, type UploadLeg} from "./post-verb.ts";
import {classifyProbe} from "./upload-leg.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const AUTHORITY_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOVED_AUTHORITY_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OLD_HEAD = "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192";
const SET_DIR = "/tmp/fabrika-review-ui/4321-03135b91/judged";
const CAPTURE_PATH = `${SET_DIR}/pano.png`;
const MANIFEST_PATH = `${SET_DIR}/manifest.json`;
const VERIFY_PATH = "/tmp/fabrika-review-ui-post-verification/pano.png";
const CI_CAPTURE_PATH = `${SET_DIR}/captures/desktop.png`;
const CI_RECEIPT_PATH = `${SET_DIR}/${CI_PROVENANCE_RECEIPT}`;
const REMOTE_CI_DIR = "/tmp/re-downloaded-ci-artifact";
const REMOTE_CI_CAPTURE_PATH = `${REMOTE_CI_DIR}/captures/desktop.png`;
const HARNESS = "/repo/design-harness.json";
const HOSTED = "https://github.com/user-attachments/assets/9c41";
const URL = "https://example.test/pull/4321#issuecomment-5154902211";
const CI_AUTHORITY = JSON.stringify({
	schemaVersion: 1,
	harnesses: [
		{
			id: "tuval",
			workflow: ".github/workflows/review-ui-localhost-evidence.yml",
			check: "review-ui localhost evidence / tuval",
			event: "pull_request_target",
			artifact: "review-ui-localhost-tuval",
			captureCommand: ["pnpm", "--filter", "tuval", "test"],
			serverBuildCommand: ["pnpm", "--filter", "tuval", "build"],
			serverCommand: ["node", "server.mjs", "4173"],
			containerPort: 4173,
			readinessPattern: "ready (http://127.0.0.1:[0-9]+)",
			captureReadySelector: ".react-flow__node",
			surfaces: [{id: "desktop", route: "/", state: "desktop", width: 1280, height: 800}],
		},
	],
});

const BYTES = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0,
	0, 0, 8, 92,
]);

const manifest = (overrides: Partial<CaptureManifest> = {}): CaptureManifest => ({
	schemaVersion: 2,
	source: "review-ui-render",
	repository: "o/r",
	set: "judged",
	pr: 4321,
	head: HEAD,
	app: "web",
	previewUrl: "https://pr-4321.example.test",
	flags: [],
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

const ciManifest = (overrides: Partial<CiCaptureManifest> = {}): CiCaptureManifest => ({
	schemaVersion: 1,
	source: "github-actions",
	repository: "o/r",
	pr: 4321,
	head: HEAD,
	harness: "tuval",
	declarationSha256: declarationDigest(CI_AUTHORITY),
	producer: {
		workflow: ".github/workflows/review-ui-localhost-evidence.yml",
		check: "review-ui localhost evidence / tuval",
		event: "pull_request_target",
		runId: 42,
		artifact: "review-ui-localhost-tuval",
		authorityHead: AUTHORITY_HEAD,
	},
	captures: [
		{
			surface: "desktop",
			route: "/",
			state: "desktop",
			path: "captures/desktop.png",
			width: 1280,
			height: 2140,
			sha256: sha256Hex(BYTES),
			pageErrors: {rows: [], more: 0},
			errorCoverage: {pageerror: "readable", consoleError: "readable"},
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
				const bytes = shape.bytes?.[path] ?? (path === REMOTE_CI_CAPTURE_PATH ? BYTES : undefined);
				return bytes === undefined ? notFound("readFile", path) : Effect.succeed(bytes);
			},
			exists: (path: string) => Effect.succeed(shape.strings?.[path] !== undefined),
		}),
		Path.layer,
	);

const world = (overrides: FsShape = {}): Layer.Layer<FileSystem.FileSystem | Path.Path> => {
	const document = overrides.strings?.[MANIFEST_PATH] ?? serializeManifest(manifest());
	return fs({
		strings: {[MANIFEST_PATH]: document, ...overrides.strings},
		bytes: {
			[CAPTURE_PATH]: BYTES,
			[VERIFY_PATH]: BYTES,
			[REMOTE_CI_CAPTURE_PATH]: BYTES,
			...overrides.bytes,
		},
	});
};

const PULL = /GET .*\/repos\/o\/r\/pulls\/4321\b/;
const REPO = /GET .*\/repos\/o\/r$/;
const AUTHORITY_COMMIT = /GET .*\/repos\/o\/r\/commits\/main$/;
const AUTHORITY = /GET .*\/repos\/o\/r\/contents\/\.github\/review-ui-localhost-harnesses\.json/;
const USER = /GET .*api\.github\.com\/user$/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4321\/comments/;
const CREATE = /POST .*\/repos\/o\/r\/issues\/4321\/comments/;
const PATCH = /PATCH .*\/repos\/o\/r\/issues\/comments\/\d+/;
const READBACK = /GET .*\/repos\/o\/r\/issues\/comments\/\d+/;
const FILES = /GET .*\/repos\/o\/r\/pulls\/4321\/files/;
const REVIEWS = /GET .*\/repos\/o\/r\/pulls\/4321\/reviews/;
const ACL = /GET .*\/repos\/o\/r\/collaborators\/[^/]+\/permission/;

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
		[
			{
				id: 7,
				body: `<!-- preview-deploy:web -->\n- **web** — Stage \`pr-4321\` → https://pr-4321.example.test <sub>(${HEAD})</sub>`,
				author: "kampus-bot",
				updatedAt: "2026-08-07T00:00:00Z",
			},
			...rows,
		].map((row) => ({
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
	renderPreview: (request: {readonly surface: string}) =>
		Effect.succeed({
			_tag: "Rendered" as const,
			entry: {
				surface: request.surface,
				path: VERIFY_PATH,
				width: 1280,
				height: 2140,
				sha256: sha256Hex(BYTES),
				pageErrors: {rows: [], more: 0},
			},
		}),
	fetchCiBundle: () =>
		Effect.succeed(
			ok({
				runId: 42,
				checkId: 9,
				artifactId: 10,
				artifactName: "review-ui-localhost-tuval",
				authorityHead: AUTHORITY_HEAD,
				directory: REMOTE_CI_DIR,
				manifestText: JSON.stringify(ciManifest()),
			}),
		),
};

const fetchedBundle = (manifestText: string) => () =>
	Effect.succeed(
		ok({
			runId: 42,
			checkId: 9,
			artifactId: 10,
			artifactName: "review-ui-localhost-tuval",
			authorityHead: AUTHORITY_HEAD,
			directory: REMOTE_CI_DIR,
			manifestText,
		}),
	);

const ciWorld = (document: string = JSON.stringify(ciManifest())) =>
	fs({
		strings: {
			[MANIFEST_PATH]: document,
			[CI_RECEIPT_PATH]: JSON.stringify({
				schemaVersion: 1,
				repository: "o/r",
				pr: 4321,
				head: HEAD,
				harness: "tuval",
				runId: 42,
				checkId: 9,
				artifactId: 10,
				manifestSha256: sha256Hex(new TextEncoder().encode(document)),
			}),
		},
		bytes: {[CI_CAPTURE_PATH]: BYTES},
	});

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
	[once(PULL), pull()],
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

	it("carries the documented abbreviated CI invocation through the exact comment into ship", async () => {
		const ciComposed = `review-ui: PASS @ 03135b91 — changes-requested\n\n${BODY.trimEnd()}\n\n## Evidence provenance\n\n- Repository: o/r\n- Workflow: .github/workflows/review-ui-localhost-evidence.yml (pull_request_target)\n- GitHub Actions run: [42](https://github.com/o/r/actions/runs/42)\n- Check: review-ui localhost evidence / tuval ([9](https://github.com/o/r/runs/9))\n- Artifact: review-ui-localhost-tuval (id 10)\n- Governed harness: tuval\n- Browser error coverage: pageerror and console.error readable for 1/1 captures\n\n## Evidence\n\n### desktop\n\n![desktop](${HOSTED})`;
		const script: ReadonlyArray<Scripted> = [
			[once(PULL), pull()],
			[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
			[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: AUTHORITY_HEAD})}],
			[AUTHORITY, {status: 200, body: CI_AUTHORITY}],
			[PULL, pull()],
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[COMMENTS, comments()],
			[CREATE, {status: 201, body: JSON.stringify({id: 5154902211, html_url: URL})}],
			[READBACK, posted(ciComposed)],
		];
		const document = JSON.stringify(ciManifest());
		const layer = fs({
			strings: {
				[MANIFEST_PATH]: document,
				[CI_RECEIPT_PATH]: JSON.stringify({
					schemaVersion: 1,
					repository: "o/r",
					pr: 4321,
					head: HEAD,
					harness: "tuval",
					runId: 42,
					checkId: 9,
					artifactId: 10,
					manifestSha256: sha256Hex(new TextEncoder().encode(document)),
				}),
			},
			bytes: {[CI_CAPTURE_PATH]: BYTES},
		});
		const {outcome, requests, bodies} = await run(
			script,
			{polarity: "PASS", sha: "03135b91"},
			layer,
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).sha).toBe("03135b91");
		const write = bodies[requests.findIndex((request) => CREATE.test(request))] ?? "";
		const body = String(JSON.parse(write).body);
		const marker = readMarker(body);
		expect(marker._tag).toBe("Found");
		if (marker._tag === "Found") expect(marker.value.namespace).toBe("review-ui");
		expect(body).toContain("GitHub Actions run: [42]");
		expect(body).toContain("Check: review-ui localhost evidence / tuval ([9]");
		expect(body).toContain("Artifact: review-ui-localhost-tuval (id 10)");
		expect(body).not.toContain(CI_CAPTURE_PATH);

		const gateSeams = fakeSeams([
			[once(PULL), pull()],
			[FILES, {status: 200, body: JSON.stringify([{filename: "apps/web/src/a.ts"}])}],
			[COMMENTS, comments({id: 5154902211, body, author: "kampus-bot"})],
			[ACL, {status: 200, body: JSON.stringify({permission: "write"})}],
			[REVIEWS, {status: 200, body: "[]"}],
		]);
		const gate = await Effect.runPromise(
			Effect.provide(
				runGate({
					pr: 4321,
					sha: HEAD,
					require: ["review-ui"],
					cp: false,
					repo: null,
					json: false,
					cwd: "/repo",
					env: {CLAUDE_PIPELINE_REPO: "o/r"},
				}),
				Layer.merge(gateSeams.layer, unconfigured),
			),
		);
		expect(gate.stdout, JSON.stringify({gate, requests: gateSeams.requests})).toContain(
			`gate\tsatisfied\t${HEAD}`,
		);
		expect(gate.stdout).toContain("ns\treview-ui\tpass\tmarker");
	});

	it("refuses when the default-branch authority moves during verified upload", async () => {
		let uploads = 0;
		const upload: UploadLeg = () => {
			uploads += 1;
			return Effect.succeed({_tag: "Hosted", url: HOSTED});
		};
		const {outcome, requests} = await run(
			[
				[once(PULL), pull()],
				[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
				[once(AUTHORITY_COMMIT), {status: 200, body: JSON.stringify({sha: AUTHORITY_HEAD})}],
				[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: MOVED_AUTHORITY_HEAD})}],
				[AUTHORITY, {status: 200, body: CI_AUTHORITY}],
				[PULL, pull()],
			],
			{upload},
			ciWorld(),
		);
		expect(uploads).toBe(1);
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
		expect(outcome.stderr.join("\n")).toContain(
			"no longer matches the governed producer declaration",
		);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("refuses when the governed declaration is revoked during verified upload", async () => {
		let uploads = 0;
		const upload: UploadLeg = () => {
			uploads += 1;
			return Effect.succeed({_tag: "Hosted", url: HOSTED});
		};
		const {outcome, requests} = await run(
			[
				[once(PULL), pull()],
				[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
				[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: AUTHORITY_HEAD})}],
				[once(AUTHORITY), {status: 200, body: CI_AUTHORITY}],
				[AUTHORITY, {status: 404, body: "{}"}],
				[PULL, pull()],
			],
			{upload},
			ciWorld(),
		);
		expect(uploads).toBe(1);
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
		expect(outcome.stderr.join("\n")).toContain("governed declaration is absent");
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("revalidates receipt check and artifact ids against the re-downloaded artifact", async () => {
		const document = JSON.stringify(ciManifest());
		for (const ids of [
			{checkId: 90, artifactId: 10},
			{checkId: 9, artifactId: 100},
		]) {
			const layer = fs({
				strings: {
					[MANIFEST_PATH]: document,
					[CI_RECEIPT_PATH]: JSON.stringify({
						schemaVersion: 1,
						repository: "o/r",
						pr: 4321,
						head: HEAD,
						harness: "tuval",
						runId: 42,
						...ids,
						manifestSha256: sha256Hex(new TextEncoder().encode(document)),
					}),
				},
				bytes: {[CI_CAPTURE_PATH]: BYTES},
			});
			const {outcome, requests} = await run(
				[
					[once(PULL), pull()],
					[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
					[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: AUTHORITY_HEAD})}],
					[AUTHORITY, {status: 200, body: CI_AUTHORITY}],
				],
				{},
				layer,
			);
			expect(outcome.code).toBe(MALFORMED_DOCUMENT);
			expect(requests.some((request) => CREATE.test(request))).toBe(false);
		}
	});

	it("refuses to turn a proven CI page crash into PASS", async () => {
		const red = ciManifest({
			captures: [
				{
					...ciManifest().captures[0]!,
					pageErrors: {rows: [{kind: "pageerror", text: "boom"}], more: 0},
				},
			],
		});
		const document = JSON.stringify(red);
		const layer = fs({
			strings: {
				[MANIFEST_PATH]: document,
				[CI_RECEIPT_PATH]: JSON.stringify({
					schemaVersion: 1,
					repository: "o/r",
					pr: 4321,
					head: HEAD,
					harness: "tuval",
					runId: 42,
					checkId: 9,
					artifactId: 10,
					manifestSha256: sha256Hex(new TextEncoder().encode(document)),
				}),
			},
			bytes: {[CI_CAPTURE_PATH]: BYTES},
		});
		const {outcome, requests} = await run(
			[
				[once(PULL), pull()],
				[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
				[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: AUTHORITY_HEAD})}],
				[AUTHORITY, {status: 200, body: CI_AUTHORITY}],
			],
			{polarity: "PASS", fetchCiBundle: fetchedBundle(document)},
			layer,
		);
		expect(outcome.code).toBe(RENDER_CRASHED);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("rejects a forged receipt with valid public identities and attacker-chosen captures", async () => {
		const forgedBytes = Uint8Array.from([...BYTES, 0x41]);
		const forgedManifest = ciManifest({
			captures: [
				{
					...ciManifest().captures[0]!,
					sha256: sha256Hex(forgedBytes),
				},
			],
		});
		const document = JSON.stringify(forgedManifest);
		const layer = fs({
			strings: {
				[MANIFEST_PATH]: document,
				[CI_RECEIPT_PATH]: JSON.stringify({
					schemaVersion: 1,
					repository: "o/r",
					pr: 4321,
					head: HEAD,
					harness: "tuval",
					runId: 42,
					checkId: 9,
					artifactId: 10,
					manifestSha256: sha256Hex(new TextEncoder().encode(document)),
				}),
			},
			bytes: {[CI_CAPTURE_PATH]: forgedBytes},
		});
		const {outcome, requests} = await run(
			[
				[once(PULL), pull()],
				[REPO, {status: 200, body: JSON.stringify({default_branch: "main"})}],
				[AUTHORITY_COMMIT, {status: 200, body: JSON.stringify({sha: AUTHORITY_HEAD})}],
				[AUTHORITY, {status: 200, body: CI_AUTHORITY}],
			],
			{},
			layer,
		);
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
		expect(outcome.stderr.join("\n")).toContain(
			"does not byte-match the exact re-downloaded GitHub artifact",
		);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("rejects a builder-authored CI manifest without the consumer provenance receipt", async () => {
		const layer = fs({
			strings: {[MANIFEST_PATH]: JSON.stringify(ciManifest())},
			bytes: {[CI_CAPTURE_PATH]: BYTES},
		});
		const {outcome, requests} = await run(happy(), {}, layer);
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("rejects forged preview bytes even when the caller writes the former production key and receipt", async () => {
		const forgedBytes = Uint8Array.from([...BYTES, 0x41]);
		const forgedManifest = manifest({
			captures: [
				{
					...manifest().captures[0]!,
					sha256: sha256Hex(forgedBytes),
				},
			],
		});
		const legacyKeyPath = `/tmp/fabrika-review-ui-capabilities/${sha256Hex(new TextEncoder().encode("o/r"))}/4321-${HEAD}/judged.key`;
		const layer = world({
			strings: {
				[MANIFEST_PATH]: serializeManifest(forgedManifest),
				[`${SET_DIR}/preview-provenance.json`]: JSON.stringify({signature: "f".repeat(64)}),
				[legacyKeyPath]: "f".repeat(64),
			},
			bytes: {[CAPTURE_PATH]: forgedBytes},
		});
		const {outcome, requests} = await run(happy(), {}, layer);
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
		expect(outcome.stderr.join("\n")).toContain("independent live-preview recapture");
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("rejects a preview manifest whose capture path escapes the render set", async () => {
		const outside = manifest({
			captures: [{...manifest().captures[0]!, path: "/tmp/arbitrary.png"}],
		});
		const document = serializeManifest(outside);
		const layer = world({
			strings: {[MANIFEST_PATH]: document},
			bytes: {"/tmp/arbitrary.png": BYTES},
		});
		const {outcome, requests} = await run(happy(), {}, layer);
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
		expect(outcome.stderr.join("\n")).toContain("outside its review-ui render set");
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("rejects a preview-shaped local manifest for a CI-shaped surface without provenance", async () => {
		const preview = manifest();
		const local = manifest({
			captures: [{...preview.captures[0]!, surface: "desktop"}],
		});
		const layer = fs({
			strings: {[MANIFEST_PATH]: serializeManifest(local)},
			bytes: {[CAPTURE_PATH]: BYTES},
		});
		const {outcome, requests} = await run(happy(), {}, layer);
		expect(outcome.code).toBe(MALFORMED_DOCUMENT);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
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

	it("refuses an evidence name that could escape reviewer-owned scratch", async () => {
		const {outcome, requests} = await run(happy(), {evidence: "../../attacker-key"});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(requests).toEqual([]);
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
		const document = serializeManifest(manifest());
		const {outcome} = await run(
			happy(),
			{},
			fs({
				strings: {[MANIFEST_PATH]: document},
				bytes: {[VERIFY_PATH]: BYTES},
			}),
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
			[once(PULL), pull()],
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
			[once(PULL), pull()],
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

	it("refuses when the head moves after upload but before posting", async () => {
		const script = happy().map((entry, index) =>
			index === 1 ? ([PULL, pull("open", OLD_HEAD)] as Scripted) : entry,
		);
		const {outcome, requests} = await run(script);
		expect(outcome.code).toBe(STALE_TREE);
		expect(requests.some((request) => CREATE.test(request))).toBe(false);
	});

	it("refuses on 8 when the write itself failed — UNKNOWN, never 1", async () => {
		const {outcome} = await run([
			[once(PULL), pull()],
			[PULL, pull()],
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[COMMENTS, comments()],
			[CREATE, {status: 502, body: "{}"}],
		]);
		expect(outcome.code).toBe(WRITE_UNKNOWN);
	});

	it("refuses on 9 when the read-back does not yield this marker", async () => {
		const {outcome} = await run([
			[once(PULL), pull()],
			[PULL, pull()],
			[USER, {status: 200, body: JSON.stringify({login: "kampus-bot"})}],
			[COMMENTS, comments()],
			[CREATE, {status: 201, body: JSON.stringify({id: 1, html_url: URL})}],
			[once(READBACK), posted("someone else's comment entirely")],
		]);
		expect(outcome.code).toBe(READBACK_MISMATCH);
	});
});
