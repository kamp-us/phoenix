import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS} from "../build/fixtures.test-support.ts";
import {fakeShell} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {BAD_SECTIONS, CAPTURE_INVALID, PRECONDITION_UNKNOWN} from "./codes.ts";
import {encodePng, type FakeBytesFsOptions, fakeBytesFs, solid} from "./fakes.test-support.ts";
import {type FetchLeg, runGolden} from "./golden-verb.ts";
import {sha256Of} from "./png.ts";

const ROOT = "/repo/trees/lane-a";
const POINTER = `${ROOT}/packages/design-capture/golden-pointer.json`;
const CANDIDATE = "/scratch/after/pano.png";

const REV_PARSE: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
];

const GOLDEN_BYTES = encodePng(2, 2, solid(2, 2, [0, 0, 0, 255]));
const GOLDEN_SHA = sha256Of(GOLDEN_BYTES);

const pointer = (surfaces: Record<string, string>) =>
	JSON.stringify({
		store: "https://depo.example",
		surfaces: Object.fromEntries(Object.entries(surfaces).map(([id, sha]) => [id, {sha256: sha}])),
	});

const serving: FetchLeg = () => Effect.succeed({_tag: "Ok", bytes: GOLDEN_BYTES});
const dead: FetchLeg = () => Effect.succeed({_tag: "Failed", reason: "connection refused"});

const run = (
	fs: FakeBytesFsOptions,
	overrides: {candidate?: string | null; fetch?: FetchLeg} = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runGolden({
				surface: "/pano",
				candidate: overrides.candidate ?? null,
				env: {},
				tmpRoot: "/tmp",
				fetch: overrides.fetch ?? serving,
			}),
			Layer.merge(fakeShell(REV_PARSE).layer, fakeBytesFs(fs).layer),
		),
	);

describe("runGolden", () => {
	it("answers unblessed as a FACT on exit 0 when the pointer names no golden", async () => {
		const outcome = await run({files: {[POINTER]: pointer({})}});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			surface: "/pano",
			blessed: false,
			golden: null,
			diff: null,
		});
	});

	it("answers unblessed when no pointer file exists at either convention path", async () => {
		const outcome = await run({files: {}});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout).blessed).toBe(false);
	});

	it("resolves the blessed golden content-addressed under the temp root", async () => {
		const outcome = await run({files: {[POINTER]: pointer({"/pano": GOLDEN_SHA})}});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			surface: "/pano",
			blessed: true,
			golden: {sha256: GOLDEN_SHA, path: `/tmp/fabrika-ui-goldens/${GOLDEN_SHA}.png`},
			diff: null,
		});
	});

	it("diffs a candidate and emits magnitude + regions, never a verdict token", async () => {
		const changed = solid(2, 2, [0, 0, 0, 255]);
		changed.set([255, 255, 255, 255], 0);
		const outcome = await run(
			{files: {[POINTER]: pointer({"/pano": GOLDEN_SHA}), [CANDIDATE]: encodePng(2, 2, changed)}},
			{candidate: CANDIDATE},
		);
		expect(outcome.code).toBe(0);
		const answer = JSON.parse(outcome.stdout);
		expect(answer.diff).toEqual({magnitude: 0.25, regions: [{x: 0, y: 0, w: 1, h: 1}]});
		expect(outcome.stdout).not.toMatch(/PASS|FAIL/);
	});

	/** #4501: an unreadable pointer resolving to an empty blessed set is the fail-open this refuses. */
	it("refuses an unparseable pointer on 4 rather than reading it as unblessed", async () => {
		const outcome = await run({files: {[POINTER]: "{"}});
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("an unreadable pointer is not an empty blessed set");
	});

	it("refuses on 11 when the golden bytes cannot be fetched", async () => {
		const outcome = await run({files: {[POINTER]: pointer({"/pano": GOLDEN_SHA})}}, {fetch: dead});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain('blessing is UNKNOWN, never "unblessed"');
	});

	it("refuses on 11 when the store answers bytes that hash to something else", async () => {
		const wrong: FetchLeg = () =>
			Effect.succeed({_tag: "Ok", bytes: encodePng(2, 2, solid(2, 2, [1, 2, 3, 255]))});
		const outcome = await run({files: {[POINTER]: pointer({"/pano": GOLDEN_SHA})}}, {fetch: wrong});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("hash to something other than");
	});

	it("refuses an invalid candidate on 16", async () => {
		const outcome = await run(
			{files: {[POINTER]: pointer({"/pano": GOLDEN_SHA}), [CANDIDATE]: new Uint8Array(0)}},
			{candidate: CANDIDATE},
		);
		expect(outcome.code).toBe(CAPTURE_INVALID);
		expect(outcome.stderr.at(-1)).toContain("is invalid (zero bytes)");
	});
});
