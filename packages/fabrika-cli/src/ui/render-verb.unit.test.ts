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
import {fakeSeams, okOut, type Scripted} from "../fakes.test-support.ts";
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

const LANE_OK: ReadonlyArray<Scripted> = [
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
];

const PNG = encodePng(4, 4, solid(4, 4, [0, 0, 0, 255]));

/** Every app the verb asks for comes up on one origin per name — the shape `spawnHarness` returns. */
const ready: HarnessLeg = (apps) =>
	Effect.succeed({
		_tag: "Ready",
		origins: new Map(apps.map((app, index) => [app.name, `http://127.0.0.1:${5173 + index}`])),
		stop: Effect.void,
	});

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
	script: ReadonlyArray<Scripted>,
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
			Layer.merge(fakeSeams(script).layer, fakeBytesFs(fs).layer),
		),
	);

const WEB = {name: "web", mount: "/", command: "pnpm dev --port {{port}}"};
const TUVAL = {
	name: "tuval-chat",
	mount: "/tuval/chat",
	basePath: "/",
	command: "pnpm proof:chat --port {{port}}",
};
const harnessFile = JSON.stringify({apps: [WEB]});
const twoApps = JSON.stringify({apps: [WEB, TUVAL]});
const SESSION = `${ROOT}/.fabrika/design-session.json`;
const withSession = JSON.stringify({
	apps: [WEB],
	storageState: ".fabrika/design-session.json",
});
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
				Layer.merge(fakeSeams(LANE_OK).layer, fs.layer),
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
			startHarness: () =>
				Effect.succeed({
					_tag: "NotReady",
					app: "web",
					readyPath: "/api/health",
					tail: "EADDRINUSE",
				}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain(
			'app "web" did not answer 200 on /api/health within the readiness bound',
		);
		expect(outcome.stderr.at(-1)).toContain("server stderr tail: EADDRINUSE");
	});

	it("refuses on 11 when an app's command dies, naming the app", async () => {
		const outcome = await run(LANE_OK, captured, {
			startHarness: () =>
				Effect.succeed({_tag: "Failed", app: "web", reason: "the command exited with 1"}),
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain('app "web" could not start: the command exited with 1');
	});

	it("refuses a missing harness declaration on 19", async () => {
		const outcome = await run(LANE_OK, {files: {}});
		expect(outcome.code).toBe(NO_HARNESS);
	});

	it("refuses a harness that violates its schema on 4", async () => {
		const outcome = await run(LANE_OK, {files: {[HARNESS]: "{}"}});
		expect(outcome.code).toBe(BAD_SECTIONS);
	});

	it("refuses on 11 when the harness declares a storageState no file backs", async () => {
		const outcome = await run(LANE_OK, {
			files: {...captured.files, [HARNESS]: withSession},
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("would capture the login page");
	});

	it("hands the resolved storageState path to the browse leg", async () => {
		const seen: Array<string | null> = [];
		const outcome = await run(
			LANE_OK,
			{files: {...captured.files, [HARNESS]: withSession, [SESSION]: PNG}},
			{
				browse: (request) => {
					seen.push(request.storageState);
					return Effect.succeed({_tag: "Captured"});
				},
			},
		);
		expect(outcome.code).toBe(0);
		expect(seen).toEqual([SESSION]);
	});

	it("browses signed out when no storageState is declared", async () => {
		const seen: Array<string | null> = [];
		const outcome = await run(LANE_OK, captured, {
			browse: (request) => {
				seen.push(request.storageState);
				return Effect.succeed({_tag: "Captured"});
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual([null]);
	});

	it("refuses a foreign lane on 18", async () => {
		const foreign: ReadonlyArray<Scripted> = LANE_OK.map((row) =>
			row[0].source.includes("comments")
				? [row[0], comments({id: 1, body: marker("other-session", LANE_UUID)})]
				: row,
		);
		const outcome = await run(foreign, captured);
		expect(outcome.code).toBe(LANE_NOT_MINE);
		expect(outcome.stderr.at(-1)).toContain("the lane is not yours");
	});

	it("refuses on 11 when the claim state cannot be read", async () => {
		const unreadable: ReadonlyArray<Scripted> = LANE_OK.map((row) =>
			row[0].source.includes("comments") ? [row[0], {status: 502, body: "{}"}] : row,
		);
		const outcome = await run(unreadable, captured);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});

describe("runRender across apps", () => {
	const bothCaptured = {
		files: {
			[HARNESS]: twoApps,
			[`${SET_DIR}/pano.png`]: PNG,
			[`${SET_DIR}/tuval-chat.png`]: PNG,
		},
	};

	it("sends each surface to its own app's origin, at that app's own path", async () => {
		const seen: Array<string> = [];
		const outcome = await run(LANE_OK, bothCaptured, {
			surfaces: ["/pano", "/tuval/chat"],
			browse: (request) => {
				seen.push(request.url);
				return Effect.succeed({_tag: "Captured"});
			},
		});
		expect(outcome.code).toBe(0);
		expect(seen).toEqual(["http://127.0.0.1:5173/pano", "http://127.0.0.1:5174/"]);
	});

	it("starts only the apps some requested surface resolves to", async () => {
		const started: Array<ReadonlyArray<string>> = [];
		const outcome = await run(LANE_OK, bothCaptured, {
			surfaces: ["/tuval/chat"],
			startHarness: (apps, root) => {
				started.push(apps.map((app) => app.name));
				return ready(apps, root);
			},
		});
		expect(outcome.code).toBe(0);
		expect(started).toEqual([["tuval-chat"]]);
	});

	it("refuses on 10 a surface no declared mount claims, naming the mounts", async () => {
		const outcome = await run(
			LANE_OK,
			{files: {[HARNESS]: JSON.stringify({apps: [TUVAL]})}},
			{
				surfaces: ["/pano"],
			},
		);
		expect(outcome.code).toBe(OFF_VOCABULARY);
		expect(outcome.stderr.at(-1)).toContain(
			'--surface "/pano" falls outside every mount design-harness.json declares (/tuval/chat)',
		);
	});
});
