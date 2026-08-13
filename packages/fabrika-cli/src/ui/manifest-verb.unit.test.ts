import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {GIT_DIRS} from "../build/fixtures.test-support.ts";
import {fakeShell} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {NO_MANIFEST, PRECONDITION_UNKNOWN} from "./codes.ts";
import {type FakeBytesFsOptions, fakeBytesFs} from "./fakes.test-support.ts";
import {runManifest} from "./manifest-verb.ts";

const REV_PARSE: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[/^git rev-parse --path-format=absolute/, GIT_DIRS],
];

const ROOT = "/repo/trees/lane-a";

const run = (
	fs: FakeBytesFsOptions,
	script: ReadonlyArray<readonly [RegExp, ExecResult]> = REV_PARSE,
) =>
	Effect.runPromise(
		Effect.provide(runManifest(), Layer.merge(fakeShell(script).layer, fakeBytesFs(fs).layer)),
	);

const MANIFEST = `${ROOT}/design-system-manifest.md`;

describe("runManifest", () => {
	it("reports every convention path, null where the repo ships none", async () => {
		const outcome = await run({files: {[MANIFEST]: "# design"}});
		expect(outcome.code).toBe(0);
		expect(JSON.parse(outcome.stdout)).toEqual({
			manifest: "design-system-manifest.md",
			registry: null,
			inventory: null,
			goldenPointer: null,
			harness: null,
			lawSource: "manifest-prose",
		});
	});

	it('reads lawSource as "registry" when the typed law is committed', async () => {
		const outcome = await run({
			files: {[MANIFEST]: "# design", [`${ROOT}/design-prohibitions.json`]: "{}"},
		});
		expect(JSON.parse(outcome.stdout).lawSource).toBe("registry");
	});

	it("prefers the package-local golden pointer over the root fallback", async () => {
		const outcome = await run({
			files: {
				[MANIFEST]: "# design",
				[`${ROOT}/packages/design-capture/golden-pointer.json`]: "{}",
				[`${ROOT}/design-goldens.json`]: "{}",
			},
		});
		expect(JSON.parse(outcome.stdout).goldenPointer).toBe(
			"packages/design-capture/golden-pointer.json",
		);
	});

	it("refuses an un-bootstrapped repo on 12, routing to front-door", async () => {
		const outcome = await run({files: {}});
		expect(outcome.code).toBe(NO_MANIFEST);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.at(-1)).toContain("no design manifest at design-system-manifest.md");
	});

	/** Presence is UNKNOWN, never "absent" — the fail-open an existsSync would have taken. */
	it("refuses an unprobeable convention path on 11", async () => {
		const outcome = await run({
			files: {[MANIFEST]: "# design"},
			unprobeable: [`${ROOT}/design-system-inventory.md`],
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain('presence is UNKNOWN, never "absent"');
	});

	it("refuses on 11 when the repo root itself cannot be resolved", async () => {
		const outcome = await run({files: {}}, [
			[/^git rev-parse/, {ok: false, stdout: "", reason: "not a git repository"}],
		]);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stderr.at(-1)).toContain("cannot resolve the repo root");
	});
});
