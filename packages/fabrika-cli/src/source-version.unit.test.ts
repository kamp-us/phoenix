import {assert, describe, it} from "@effect/vitest";
import {Effect, Fiber, Layer} from "effect";
import {TestClock} from "effect/testing";
import {ChildProcessSpawner} from "effect/unstable/process";
import {errOut, type FakeShell, fakeShell, faultingShell, okOut} from "./fakes.test-support.ts";
import {asksForVersion, isSourceModule, SOURCE_READ_BOUND, versionFor} from "./source-version.ts";
import {displayVersion, VERSION} from "./version.ts";

const SOURCE_URL = "file:///checkout/packages/fabrika-cli/src/source-version.ts";
const DIST_URL = "file:///repo/node_modules/@kampus/fabrika-cli/dist/source-version.js";
const PACKAGE_DIR = "/checkout/packages/fabrika-cli/";

const cleanCheckout = () =>
	fakeShell([
		[/rev-parse --short HEAD/, okOut("2b61b57\n")],
		[/status --porcelain --untracked-files=no/, okOut("")],
	]);

describe("displayVersion", () => {
	it("is the plain version with no source reading", () => {
		assert.strictEqual(displayVersion("0.7.1", null), "0.7.1");
	});

	it("names the commit for a clean source reading", () => {
		assert.strictEqual(
			displayVersion("0.7.1", {sha: "2b61b57", dirty: false}),
			"0.7.1+2b61b57 (source)",
		);
	});

	it("marks a dirty source reading", () => {
		assert.strictEqual(
			displayVersion("0.7.1", {sha: "2b61b57", dirty: true}),
			"0.7.1+2b61b57-dirty (source)",
		);
	});
});

describe("asksForVersion", () => {
	it("sees the long flag, its alias and its valued spelling", () => {
		assert.isTrue(asksForVersion(["--version"]));
		assert.isTrue(asksForVersion(["-v"]));
		assert.isTrue(asksForVersion(["build", "--version=true"]));
	});

	it("does not see a verb run or a token past end-of-options", () => {
		assert.isFalse(asksForVersion([]));
		assert.isFalse(asksForVersion(["build", "tree", "--require-clean"]));
		assert.isFalse(asksForVersion(["wire", "--", "--version"]));
	});
});

describe("isSourceModule", () => {
	it("tells the .ts source from the compiled dist", () => {
		assert.isTrue(isSourceModule(SOURCE_URL));
		assert.isFalse(isSourceModule(DIST_URL));
	});
});

/** What `versionFor` answered, beside every command line it spawned to answer it. */
const run = (
	argv: ReadonlyArray<string>,
	moduleUrl: string,
	shell: FakeShell,
): Effect.Effect<{readonly version: string; readonly calls: ReadonlyArray<string>}> =>
	versionFor(argv, moduleUrl).pipe(
		Effect.map((version) => ({version, calls: shell.calls})),
		Effect.provide(shell.layer),
	);

describe("versionFor", () => {
	it.effect("reads the package's own directory, not the cwd", () =>
		Effect.gen(function* () {
			const {version, calls} = yield* run(["--version"], SOURCE_URL, cleanCheckout());
			assert.strictEqual(version, `${VERSION}+2b61b57 (source)`);
			assert.deepStrictEqual(calls, [
				`git -C ${PACKAGE_DIR} rev-parse --short HEAD`,
				`git -C ${PACKAGE_DIR} status --porcelain --untracked-files=no`,
			]);
		}),
	);

	it.effect("marks tracked changes dirty", () =>
		Effect.gen(function* () {
			const shell = fakeShell([
				[/rev-parse --short HEAD/, okOut("2b61b57\n")],
				[/status --porcelain/, okOut(" M src/run.ts\n")],
			]);
			const {version} = yield* run(["--version"], SOURCE_URL, shell);
			assert.strictEqual(version, `${VERSION}+2b61b57-dirty (source)`);
		}),
	);

	it.effect("spawns no git when argv does not ask for the version", () =>
		Effect.gen(function* () {
			const {version, calls} = yield* run(["build", "tree"], SOURCE_URL, cleanCheckout());
			assert.strictEqual(version, VERSION);
			assert.deepStrictEqual(calls, []);
		}),
	);

	it.effect("spawns no git from the published build, even asked for the version", () =>
		Effect.gen(function* () {
			const {version, calls} = yield* run(["--version"], DIST_URL, cleanCheckout());
			assert.strictEqual(version, VERSION);
			assert.deepStrictEqual(calls, []);
		}),
	);

	it.effect("falls back to the plain version when git is missing", () =>
		Effect.gen(function* () {
			const version = yield* versionFor(["--version"], SOURCE_URL).pipe(
				Effect.provide(faultingShell),
			);
			assert.strictEqual(version, VERSION);
		}),
	);

	it.effect("falls back to the plain version when git exits non-zero", () =>
		Effect.gen(function* () {
			const shell = fakeShell([[/rev-parse/, errOut("fatal: not a git repository")]]);
			const {version} = yield* run(["--version"], SOURCE_URL, shell);
			assert.strictEqual(version, VERSION);
		}),
	);

	it.effect("falls back to the plain version when the status read fails", () =>
		Effect.gen(function* () {
			const shell = fakeShell([
				[/rev-parse/, okOut("2b61b57\n")],
				[/status/, errOut("fatal: index file corrupt")],
			]);
			const {version} = yield* run(["--version"], SOURCE_URL, shell);
			assert.strictEqual(version, VERSION);
		}),
	);

	it.effect("falls back to the plain version when git does not answer within the bound", () => {
		const hanging = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
			ChildProcessSpawner.make(() => Effect.never),
		);
		return Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(versionFor(["--version"], SOURCE_URL));
			yield* TestClock.adjust(SOURCE_READ_BOUND);
			assert.strictEqual(yield* Fiber.join(fiber), VERSION);
		}).pipe(Effect.provide(hanging));
	});
});
