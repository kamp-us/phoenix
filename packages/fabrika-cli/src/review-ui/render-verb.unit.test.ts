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
import {parseManifest} from "./manifest.ts";
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
	app: null,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r"} as Record<string, string | undefined>,
	tmpRoot: "/tmp",
	render: legOf({}),
};

const run = (script: ReadonlyArray<Scripted>, overrides: Partial<typeof options> = {}) => {
	const fs = fakeFs({});
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
	it("captures the surface, prints the manifest, and writes the same bytes to the set", async () => {
		const {outcome, written} = await run(happy());
		expect(outcome.code).toBe(0);
		const manifest = parseManifest(outcome.stdout);
		expect(manifest._tag).toBe("Manifest");
		expect(written.get("/tmp/fabrika-review-ui/4321-03135b91/judged/manifest.json")).toBe(
			outcome.stdout.trimEnd(),
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

	it("refuses a non-kebab --out and a reserved :state suffix on 10", async () => {
		expect((await run(happy(), {out: "Judged"})).outcome.code).toBe(OFF_VOCABULARY);
		expect((await run(happy(), {surfaces: ["/pano:empty"]})).outcome.code).toBe(OFF_VOCABULARY);
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
