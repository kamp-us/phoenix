import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {
	comments,
	GIT_DIRS,
	issue,
	LANE_UUID,
	marker,
	NONCE,
} from "../build/fixtures.test-support.ts";
import {fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {FAILED} from "../verb.ts";
import {
	BAD_SECTIONS,
	CAPTURE_INVALID,
	LANE_NOT_MINE,
	NO_HARNESS,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	RENDER_CRASHED,
	SURFACE_UNREACHABLE,
} from "./codes.ts";
import {encodePng, type FakeBytesFsOptions, fakeBytesFs, solid} from "./fakes.test-support.ts";
import {type BrowseLeg, type HarnessLeg, runRender, type ShotOutcome} from "./render-verb.ts";

const ROOT = "/repo/trees/lane-a";
const HARNESS = `${ROOT}/design-harness.json`;
const LANE = `build/4312-editor-focus-loss-${NONCE}`;
const SET_DIR = `/tmp/fabrika-build/s-9f2e/4312-${NONCE}/after`;

const LANE_OK: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
	[/^git rev-parse --abbrev-ref HEAD$/, okOut(`${LANE}\n`)],
	[/^gh api repos\/o\/r\/issues\/4312$/, issue()],
	[
		/^gh api --paginate repos\/o\/r\/issues\/4312\/comments/,
		comments({id: 1, body: marker("s-9f2e", LANE_UUID)}),
	],
	[/^gh api repos\/o\/r\/collaborators\/agent\/permission/, okOut("write\n")],
];

const PNG = encodePng(4, 4, solid(4, 4, [0, 0, 0, 255]));

const ready: HarnessLeg = () => Effect.succeed({_tag: "Ready", stop: Effect.void});

const options = {
	out: "after",
	surfaces: ["/pano"],
	firstRender: [] as ReadonlyArray<string>,
	repo: null,
	env: {CLAUDE_PIPELINE_REPO: "o/r", CLAUDE_CODE_SESSION_ID: "s-9f2e"} as Record<
		string,
		string | undefined
	>,
	tmpRoot: "/tmp",
	startHarness: ready,
};

/** A browse leg that returns a scripted outcome per surface and "writes" the PNG the fake fs holds. */
const browsing =
	(outcome: (url: string) => ShotOutcome): BrowseLeg =>
	(request) =>
		Effect.succeed(outcome(request.url));

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	fs: FakeBytesFsOptions,
	overrides: Partial<typeof options> & {browse?: BrowseLeg} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runRender({
				...options,
				browse: browsing(() => ({_tag: "Captured"})),
				...overrides,
			}),
			Layer.merge(fakeShell(script).layer, fakeBytesFs(fs).layer),
		),
	);

const harnessFile = JSON.stringify({command: "pnpm dev", url: "http://127.0.0.1:5173"});
const captured = {files: {[HARNESS]: harnessFile, [`${SET_DIR}/pano.png`]: PNG}};

describe("runRender operands", () => {
	it("refuses zero surfaces on 1 — no tool guesses surfaces from a diff", async () => {
		const outcome = await run([], {}, {surfaces: []});
		expect(outcome.code).toBe(FAILED);
	});

	it.each([
		["a non-kebab --out", {out: "After"}, '--out "After" is not a kebab-case set name'],
		["a reserved :state suffix", {surfaces: ["/pano:empty"]}, "carries a :state suffix"],
	])("refuses %s on 10", async (_label, overrides, fragment) => {
		const outcome = await run([], {}, overrides);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain(fragment);
	});

	it("refuses a --first-render naming a surface it is not rendering", async () => {
		const outcome = await run([], {}, {firstRender: ["/sozluk"]});
		expect(outcome.code).toBe(FAILED);
	});
});

describe("runRender", () => {
	it("answers the validated capture set and writes the manifest byte-identically", async () => {
		const fs = fakeBytesFs(captured);
		const outcome = await Effect.runPromise(
			Effect.provide(
				runRender({...options, browse: browsing(() => ({_tag: "Captured"}))}),
				Layer.merge(fakeShell(LANE_OK).layer, fs.layer),
			),
		);
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			set: "after",
			captures: [
				{
					surface: "/pano",
					path: `${SET_DIR}/pano.png`,
					width: 4,
					height: 4,
					sha256: expect.any(String),
					firstRender: false,
				},
			],
		});
		const written = fs.written.get(`${SET_DIR}/manifest.json`);
		expect(new TextDecoder().decode(written)).toBe(outcome.stdout);
	});

	it("records a --first-render surface as such", async () => {
		const outcome = await run(LANE_OK, captured, {firstRender: ["/pano"]});
		expect(JSON.parse(outcome.stdout).captures[0].firstRender).toBe(true);
	});

	it.each([
		[
			"an unreachable surface",
			() => ({_tag: "Unreachable", reason: "HTTP 404"}) as ShotOutcome,
			SURFACE_UNREACHABLE,
			"is unreachable in this tree",
		],
		[
			"a crashed render",
			() => ({_tag: "Crashed", error: "TypeError: x"}) as ShotOutcome,
			RENDER_CRASHED,
			"threw during render",
		],
	])("refuses %s, naming it on stderr", async (_label, shot, code, fragment) => {
		const outcome = await run(LANE_OK, captured, {browse: browsing(shot)});
		expect(outcome.code).toBe(code);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain(fragment);
	});

	it("refuses an invalid capture on 16 — evidence nobody can open is not evidence", async () => {
		const outcome = await run(LANE_OK, {
			files: {[HARNESS]: harnessFile, [`${SET_DIR}/pano.png`]: new Uint8Array(0)},
		});
		expect(outcome.code).toBe(CAPTURE_INVALID);
		expect(outcome.stderr.join("\n")).toContain("captured invalid bytes (zero bytes)");
	});

	it("reports the SMALLEST applicable code when outcomes mix, and enumerates every surface", async () => {
		const outcome = await run(
			LANE_OK,
			{files: {[HARNESS]: harnessFile, [`${SET_DIR}/pano.png`]: PNG}},
			{
				surfaces: ["/pano", "/sozluk", "/yeni"],
				browse: browsing((url) =>
					url.endsWith("/sozluk")
						? {_tag: "Crashed", error: "TypeError: x"}
						: url.endsWith("/yeni")
							? {_tag: "Unreachable", reason: "HTTP 404"}
							: {_tag: "Captured"},
				),
			},
		);
		expect(outcome.code).toBe(RENDER_CRASHED);
		expect(outcome.stderr.join("\n")).toContain("threw during render");
		expect(outcome.stderr.join("\n")).toContain("is unreachable in this tree");
	});

	it("refuses on 11 when the harness never answers", async () => {
		const outcome = await run(LANE_OK, captured, {
			startHarness: () => Effect.succeed({_tag: "NotReady", tail: "EADDRINUSE"}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("server stderr tail: EADDRINUSE");
	});

	it("refuses a missing harness declaration on 19", async () => {
		const outcome = await run(LANE_OK, {files: {}});
		expect(outcome.code).toBe(NO_HARNESS);
	});

	it("refuses a harness that violates its schema on 4", async () => {
		const outcome = await run(LANE_OK, {files: {[HARNESS]: "{}"}});
		expect(outcome.code).toBe(BAD_SECTIONS);
	});

	it("refuses a foreign lane on 18", async () => {
		const foreign = LANE_OK.map((row) =>
			row[0].source.includes("comments")
				? ([row[0], comments({id: 1, body: marker("other-session", LANE_UUID)})] as const)
				: row,
		);
		const outcome = await run(foreign, captured);
		expect(outcome.code).toBe(LANE_NOT_MINE);
		expect(outcome.stderr.at(-1)).toContain("the lane is not yours");
	});

	it("refuses on 11 when the claim state cannot be read", async () => {
		const unreadable = LANE_OK.map((row) =>
			row[0].source.includes("comments")
				? ([row[0], {ok: false, stdout: "", reason: "HTTP 502"}] as const)
				: row,
		);
		const outcome = await run(unreadable, captured);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
