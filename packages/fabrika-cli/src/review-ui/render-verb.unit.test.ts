import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs, fakeSeams, type HttpReply, type Scripted} from "../fakes.test-support.ts";
import {
	INVALID_CAPTURE,
	NO_PREVIEW,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	RENDER_CRASHED,
	STALE_TREE,
	SURFACE_UNREACHABLE,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	PREVIEW_PROVENANCE_RECEIPT,
	parseManifest,
	parsePreviewProvenance,
	previewProvenanceCapabilityPath,
	sha256Hex,
	verifyPreviewProvenance,
} from "./manifest.ts";
import {type RenderLeg, runRender, type SurfaceRender} from "./render-verb.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const PREVIEW = "https://pr-4321-web.example.test";

const PULL = /GET .*\/repos\/o\/r\/pulls\/4321\b/;
const COMMENTS = /GET .*\/repos\/o\/r\/issues\/4321\/comments/;

const pull = (state = "open", head = HEAD): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: 4321,
		state,
		head: {sha: head},
		base: {ref: "main"},
		body: "",
		changed_files: 2,
		comments: 1,
	}),
});

const announcement = (sha: string = HEAD.slice(0, 7)): HttpReply => ({
	status: 200,
	body: JSON.stringify([
		{
			id: 7,
			user: {login: "kampus-bot"},
			created_at: "2026-08-09T00:00:00Z",
			updated_at: "2026-08-09T00:00:00Z",
			body: `<!-- preview-deploy:web -->\n- **web** — Stage \`pr-4321\` → ${PREVIEW} <sub>(${sha})</sub>`,
		},
	]),
});

const rendered = (surface: string, outDir: string): SurfaceRender => ({
	_tag: "Rendered",
	entry: {
		surface,
		path: `${outDir}/${surface.replace(/^\//, "")}.png`,
		width: 1280,
		height: 2140,
		sha256: "9c41",
		pageErrors: {rows: [], more: 0},
	},
});

/** A leg that answers per surface, so a mixed set is as expressible as a clean one. */
const legOf =
	(answers: Readonly<Record<string, SurfaceRender>>): RenderLeg =>
	(request) =>
		Effect.succeed(answers[request.surface] ?? rendered(request.surface, request.outDir));

const options = {
	pr: 4321,
	out: "judged",
	surfaces: ["/pano"],
	flags: [] as readonly string[],
	app: null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	tmpRoot: "/tmp",
	render: legOf({}),
};

const run = (
	script: ReadonlyArray<Scripted>,
	overrides: Partial<typeof options> = {},
	fsOptions: Parameters<typeof fakeFs>[0] = {},
) => {
	const fs = fakeFs(fsOptions);
	return Effect.runPromise(
		Effect.provide(
			runRender({...options, ...overrides}),
			Layer.merge(fakeSeams(script).layer, fs.layer),
		),
	).then((outcome) => ({outcome, written: fs.written}));
};

const happy = (): ReadonlyArray<Scripted> => [
	[PULL, pull()],
	[COMMENTS, announcement()],
];

describe("runRender", () => {
	it("captures the surface and writes the manifest plus render provenance", async () => {
		const {outcome, written} = await run(happy());
		expect(outcome.code).toBe(0);
		const manifest = parseManifest(outcome.stdout);
		expect(manifest._tag).toBe("Manifest");
		const document = outcome.stdout.trimEnd();
		expect(written.get("/tmp/fabrika-review-ui/4321-03135b91/judged/manifest.json")).toBe(document);
		const receipt = parsePreviewProvenance(
			written.get(`/tmp/fabrika-review-ui/4321-03135b91/judged/${PREVIEW_PROVENANCE_RECEIPT}`) ??
				"",
		);
		expect(receipt).toMatchObject({
			source: "review-ui-render",
			repository: "o/r",
			pr: 4321,
			head: HEAD,
			app: "web",
			previewUrl: PREVIEW,
			manifestSha256: sha256Hex(new TextEncoder().encode(document)),
		});
		expect(receipt).not.toBeNull();
		if (receipt !== null) {
			const capability = written.get(
				previewProvenanceCapabilityPath("/tmp", "o/r", 4321, HEAD, "judged"),
			);
			expect(capability).toBeDefined();
			expect(verifyPreviewProvenance(receipt, capability ?? "")).toBe(true);
		}
	});

	it.each([
		"/tmp/fabrika-review-ui/4321-03135b91/judged/manifest.json",
		`/tmp/fabrika-review-ui/4321-03135b91/judged/${PREVIEW_PROVENANCE_RECEIPT}`,
		previewProvenanceCapabilityPath("/tmp", "o/r", 4321, HEAD, "judged"),
	])("refuses when required render output cannot be written: %s", async (path) => {
		const {outcome} = await run(happy(), {}, {unwritable: [path]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(
			"cannot write the set manifest and preview provenance",
		);
	});

	it("prints the capped page errors on both channels, so the file reader cannot desync (ADR 0308)", async () => {
		const noisy: SurfaceRender = {
			_tag: "Rendered",
			entry: {
				surface: "/pano",
				path: "/tmp/fabrika-review-ui/4321-03135b91/judged/pano.png",
				width: 1280,
				height: 2140,
				sha256: "9c41",
				pageErrors: {rows: [{kind: "console.error", text: "Warning: a"}], more: 12},
			},
		};
		const {outcome, written} = await run(happy(), {render: legOf({"/pano": noisy})});
		expect(outcome.code).toBe(0);
		const read = parseManifest(outcome.stdout);
		expect(read).toMatchObject({
			_tag: "Manifest",
			value: {captures: [{pageErrors: {rows: [{text: "Warning: a"}], more: 12}}]},
		});
		expect(outcome.stdout).not.toContain('"pageErrors":[');
		expect(written.get("/tmp/fabrika-review-ui/4321-03135b91/judged/manifest.json")).toBe(
			outcome.stdout.trimEnd(),
		);
		// The stderr tally is the whole list, not the kept rows — the collapse must not shrink the count.
		expect(outcome.stderr).toContain(
			'review-ui render: surface "/pano" captured: 1280x2140, 13 page error(s)',
		);
	});

	it("enumerates every surface's outcome on stderr, success included", async () => {
		const {outcome} = await run(happy(), {surfaces: ["/pano", "/pano/yeni"]});
		expect(outcome.code).toBe(0);
		expect(outcome.stderr.filter((line) => line.includes("captured:"))).toHaveLength(2);
	});

	it("refuses zero surfaces — `rendered nothing, found nothing wrong` is not an answer", async () => {
		const {outcome} = await run(happy(), {surfaces: []});
		expect(outcome.code).toBe(1);
	});

	it("refuses a non-kebab --out and an unrealized :state suffix on 10", async () => {
		expect((await run(happy(), {out: "Judged"})).outcome.code).toBe(OFF_VOCABULARY);
		expect((await run(happy(), {surfaces: ["/pano:empty"]})).outcome.code).toBe(OFF_VOCABULARY);
	});

	// An `:auth` surface rendered anonymously is the "unseen ground reading as clean" defect
	// (#7051), so a half-set or absent credential pair is UNKNOWN rather than a visitor's shot.
	it("refuses an :auth surface with no credentials on 11, never the anonymous render", async () => {
		expect((await run(happy(), {surfaces: ["/pano:auth"]})).outcome.code).toBe(
			PRECONDITION_UNKNOWN,
		);
		const halfSet = await run(happy(), {
			surfaces: ["/pano:auth"],
			env: {CLAUDE_PIPELINE_REPO: "o/r", PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32)},
		});
		expect(halfSet.outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(halfSet.outcome.stderr.join("\n")).toContain("BETTER_AUTH_SECRET");
	});

	it("seeds the session cookie onto the :auth surface only, so the default stays the visitor's", async () => {
		const seen = new Map<string, number>();
		const {outcome} = await run(happy(), {
			surfaces: ["/pano", "/pano:auth"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: (request) => {
				seen.set(request.surface, request.cookies.length);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen.get("/pano")).toBe(0);
		expect(seen.get("/pano:auth")).toBe(2);
	});

	// The credential check only proves the pair was SET. Whether the cookie actually authenticated is
	// the shot's own answer, and a shot that came back a visitor's is UNKNOWN — never a red surface,
	// because the page rendered fine, and never a Rendered entry under the `:auth` id (#7051).
	it("refuses an :auth shot that did not render signed in on 11, recording no capture", async () => {
		const {outcome, written} = await run(happy(), {
			surfaces: ["/pano:auth"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: legOf({
				"/pano:auth": {
					_tag: "Unauthenticated",
					reason: "the preview answered the seeded cookie as a visitor",
				},
			}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
		expect(outcome.stderr.at(-1)).toMatch(/did not render signed in/);
	});

	// Routed ahead of the proven-red codes: a fine PNG of the wrong page is not a defect in the PR.
	it("routes an unauthenticated surface as UNKNOWN even beside a crashed one", async () => {
		const {outcome} = await run(happy(), {
			surfaces: ["/a:auth", "/b"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: legOf({
				"/a:auth": {_tag: "Unauthenticated", reason: "probe answered 500"},
				"/b": {_tag: "Crashed", firstError: "TypeError: x is null"},
			}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	// The operand's own refusals, decided before a browser launches. Both are `10`: an operand
	// nothing can force and an operand the preview would silently drop are the same defect — the
	// default state shot under the forced name (#7218).
	it("refuses a malformed --flag operand on 10, naming the token and why", async () => {
		const {outcome} = await run(happy(), {surfaces: ["/pano:auth"], flags: ["phoenix-welcome"]});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.join("\n")).toContain("no = separating the key from its value");
		expect((await run(happy(), {surfaces: ["/pano:auth"], flags: ["a=true"]})).outcome.code).toBe(
			OFF_VOCABULARY,
		);
	});

	it("refuses --flag beside an anonymous surface on 10 — the preview would drop the cookie", async () => {
		const {outcome} = await run(happy(), {
			surfaces: ["/pano:auth", "/hosgeldin"],
			flags: ["phoenix-welcome=on"],
		});
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.join("\n")).toContain('anonymous surface "/hosgeldin"');
	});

	it("composes the override with the seeded session — one signed-in, flag-on shot", async () => {
		const seen = new Map<string, {cookies: number; forced: Record<string, boolean>}>();
		const {outcome} = await run(happy(), {
			surfaces: ["/hosgeldin:auth"],
			flags: ["phoenix-welcome=on"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: (request) => {
				seen.set(request.surface, {
					cookies: request.cookies.length,
					forced: request.forcedFlags,
				});
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		// Two session cookies (prefixed and bare) plus the one override cookie.
		expect(seen.get("/hosgeldin:auth")).toEqual({
			cookies: 3,
			forced: {"phoenix-welcome": true},
		});
	});

	it("forces nothing when no --flag is passed, so the default run is untouched", async () => {
		const seen: Array<Record<string, boolean>> = [];
		const {outcome} = await run(happy(), {
			render: (request) => {
				seen.push(request.forcedFlags);
				return Effect.succeed(rendered(request.surface, request.outDir));
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual([{}]);
	});

	// A fine PNG of the flag-off page is not a defect in the PR, so it routes UNKNOWN beside a red one.
	it("refuses an inert override on 11, recording no capture", async () => {
		const {outcome, written} = await run(happy(), {
			surfaces: ["/hosgeldin:auth", "/b:auth"],
			flags: ["phoenix-welcome=on"],
			env: {
				CLAUDE_PIPELINE_REPO: "o/r",
				PREVIEW_TEST_SESSION_TOKEN: "t".repeat(32),
				BETTER_AUTH_SECRET: "s".repeat(32),
			},
			render: legOf({
				"/hosgeldin:auth": {
					_tag: "OverrideInert",
					reason: "the preview evaluated phoenix-welcome at the default",
				},
				"/b:auth": {_tag: "Crashed", firstError: "TypeError: x is null"},
			}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(written.size).toBe(0);
		expect(outcome.stderr.at(-1)).toMatch(/did not render with its forced flags/);
	});

	it("refuses a closed PR on 7 — a closed PR is provably not reviewable scope", async () => {
		const {outcome} = await run([
			[PULL, pull("closed")],
			[COMMENTS, announcement()],
		]);
		expect(outcome.code).toBe(ZERO_SCOPE);
	});

	it("proves CANT-SEE (16) only when no comment carries the preview anchor", async () => {
		const none: HttpReply = {
			status: 200,
			body: JSON.stringify([
				{id: 1, user: {login: "x"}, created_at: "", updated_at: "", body: "looks fine"},
			]),
		};
		const {outcome} = await run([
			[PULL, pull()],
			[COMMENTS, none],
		]);
		expect(outcome.code).toBe(NO_PREVIEW);
	});

	it("calls a malformed announcement UNKNOWN (11), never absent", async () => {
		const malformed: HttpReply = {
			status: 200,
			body: JSON.stringify([
				{
					id: 1,
					user: {login: "x"},
					created_at: "",
					updated_at: "",
					body: "<!-- preview-deploy:web -->\n- **web** — the deploy failed",
				},
			]),
		};
		const {outcome} = await run([
			[PULL, pull()],
			[COMMENTS, malformed],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});

	it("refuses a preview that lags the live head on 12 — old pixels never bind a new head", async () => {
		const {outcome} = await run([
			[PULL, pull()],
			[COMMENTS, announcement("0b1c2d3")],
		]);
		expect(outcome.code).toBe(STALE_TREE);
		expect(outcome.stderr.at(-1)).toMatch(/stale preview/);
	});

	it("routes mixed outcomes by the smallest applicable code, enumerating all of them", async () => {
		const {outcome} = await run(happy(), {
			surfaces: ["/a", "/b", "/c"],
			render: legOf({
				"/a": {_tag: "Unreachable", reason: "status 404"},
				"/b": {_tag: "Crashed", firstError: "TypeError: x is null"},
				"/c": {_tag: "Invalid", detail: "zero bytes"},
			}),
		});
		expect(outcome.code).toBe(RENDER_CRASHED);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.some((line) => line.includes("unreachable"))).toBe(true);
		expect(outcome.stderr.some((line) => line.includes("invalid bytes"))).toBe(true);
		// The refusal names a surface the ROUTED code applies to, not merely the first bad one.
		expect(outcome.stderr.at(-1)).toMatch(/surface "\/b" threw during render/);
	});

	it("seats an unreachable-only set on 14 and an invalid-only set on 15", async () => {
		const unreachable = await run(happy(), {
			render: legOf({"/pano": {_tag: "Unreachable", reason: "status 404"}}),
		});
		expect(unreachable.outcome.code).toBe(SURFACE_UNREACHABLE);
		const invalid = await run(happy(), {
			render: legOf({"/pano": {_tag: "Invalid", detail: "zero bytes"}}),
		});
		expect(invalid.outcome.code).toBe(INVALID_CAPTURE);
	});

	it("keeps a render that never became answerable UNKNOWN (11), not a bad render", async () => {
		const {outcome} = await run(happy(), {
			render: legOf({"/pano": {_tag: "Failed", reason: "the browser provision is broken"}}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
