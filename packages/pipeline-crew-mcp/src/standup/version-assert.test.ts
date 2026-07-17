/**
 * standup/version-assert — the pre-launch pinned-CLI-version assert (issue #3295). Covers the
 * three decisions the assert makes with the launch side stubbed via an injected version reader:
 * installed == pinned proceeds silently, installed != pinned aborts naming both versions, and an
 * unreadable/unparseable installed version aborts. Also covers the pure `parseCliVersion` extractor.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {assertPinnedCliVersion, CliVersionAssertError, parseCliVersion} from "./version-assert.ts";

/** The whole assert consumes is the pinned version; a `Pick<LaunchConfig, "cliVersion">` is enough. */
const pinnedAt = (cliVersion: string) => ({cliVersion});

describe("standup/version-assert — parseCliVersion", () => {
	it("extracts the version token from real `claude --version` output", () => {
		assert.strictEqual(parseCliVersion("2.1.207 (Claude Code)\n"), "2.1.207");
	});
	it("extracts a pre-release version", () => {
		assert.strictEqual(parseCliVersion("2.1.207-beta.3 (Claude Code)"), "2.1.207-beta.3");
	});
	it("returns null when no version token is present", () => {
		assert.strictEqual(parseCliVersion("command not found"), null);
		assert.strictEqual(parseCliVersion(""), null);
	});
});

describe("standup/version-assert — assertPinnedCliVersion", () => {
	it.effect("proceeds silently when installed == pinned", () =>
		Effect.gen(function* () {
			// A void success is the whole contract of a match — no error, nothing to assert on but the exit.
			yield* assertPinnedCliVersion(pinnedAt("2.1.207"), Effect.succeed("2.1.207 (Claude Code)"));
		}),
	);

	it.effect("aborts naming BOTH versions when installed != pinned", () =>
		Effect.gen(function* () {
			const err = yield* Effect.flip(
				assertPinnedCliVersion(pinnedAt("2.1.207"), Effect.succeed("2.1.300 (Claude Code)")),
			);
			assert.instanceOf(err, CliVersionAssertError);
			assert.strictEqual(err.installed, "2.1.300");
			assert.strictEqual(err.pinned, "2.1.207");
			// the error must name both versions so the operator can see the drift at a glance
			assert.include(err.reason, "2.1.300");
			assert.include(err.reason, "2.1.207");
		}),
	);

	it.effect("aborts when the installed version cannot be read (launch side unreadable)", () =>
		Effect.gen(function* () {
			// a stubbed reader whose error channel is a plain string models the launch-side subprocess failing
			const err = yield* Effect.flip(
				assertPinnedCliVersion(pinnedAt("2.1.207"), Effect.fail("spawn claude ENOENT")),
			);
			assert.instanceOf(err, CliVersionAssertError);
			assert.strictEqual(err.installed, null);
			assert.strictEqual(err.pinned, "2.1.207");
			assert.include(err.reason, "ENOENT");
		}),
	);

	it.effect("aborts when the installed version output has no parseable version", () =>
		Effect.gen(function* () {
			const err = yield* Effect.flip(
				assertPinnedCliVersion(pinnedAt("2.1.207"), Effect.succeed("not a version at all")),
			);
			assert.instanceOf(err, CliVersionAssertError);
			assert.strictEqual(err.installed, null);
			assert.include(err.reason, "not a version at all");
		}),
	);
});
