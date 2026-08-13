import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS} from "../build/fixtures.test-support.ts";
import {fakeShell} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {BAD_SECTIONS, NO_MANIFEST, PRECONDITION_UNKNOWN, UNTYPED_LAW} from "./codes.ts";
import {type FakeBytesFsOptions, fakeBytesFs} from "./fakes.test-support.ts";
import {runLaw} from "./law-verb.ts";

const ROOT = "/repo/trees/lane-a";
const MANIFEST = `${ROOT}/design-system-manifest.md`;
const REGISTRY = `${ROOT}/design-prohibitions.json`;

const REV_PARSE: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
];

const run = (fs: FakeBytesFsOptions) =>
	Effect.runPromise(
		Effect.provide(runLaw(), Layer.merge(fakeShell(REV_PARSE).layer, fakeBytesFs(fs).layer)),
	);

const ROW = {
	id: "faint-token-meaning",
	pillar: "color",
	class: "blocking",
	machineCheck: "vlm",
	source: "design-system-manifest.md#four-pillars",
	statement: "A meaning-carrying label never sits on a decorative faint token.",
	counterexample: "Timestamp-styled --text-faint on the error banner's message.",
};

describe("runLaw", () => {
	it("emits the registry's rows verbatim under lawSource registry", async () => {
		const outcome = await run({
			files: {[MANIFEST]: "# design", [REGISTRY]: JSON.stringify({rows: [ROW]})},
		});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({lawSource: "registry", rows: [ROW]});
	});

	/** Untyped, mistyped and unreadable are three different facts — the fallback is legal in one. */
	it("refuses an untyped law on 13, naming the prose fallback", async () => {
		const outcome = await run({files: {[MANIFEST]: "# design"}});
		expect(outcome.code).toBe(UNTYPED_LAW);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("LAW-SOURCE: manifest-prose");
	});

	it("refuses a schema violation on 4, whole-file", async () => {
		const outcome = await run({
			files: {[MANIFEST]: "# design", [REGISTRY]: JSON.stringify({rows: []})},
		});
		expect(outcome.code).toBe(BAD_SECTIONS);
		expect(outcome.stderr.at(-1)).toContain("half a law is not a law");
	});

	it("refuses an unreadable registry on 11, never as untyped", async () => {
		const outcome = await run({files: {[MANIFEST]: "# design"}, unprobeable: [REGISTRY]});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain('the law is UNKNOWN, never "untyped"');
	});

	it("refuses a missing manifest on 12 — the law question does not arise", async () => {
		const outcome = await run({files: {}});
		expect(outcome.code).toBe(NO_MANIFEST);
	});
});
