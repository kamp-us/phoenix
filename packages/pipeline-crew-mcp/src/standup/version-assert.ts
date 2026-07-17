/**
 * standup/version-assert — the pre-launch pinned-CLI-version assert for the stand-up launcher
 * (issue #3295). At stand-up it reads the installed Claude Code CLI version and compares it to the
 * pinned `cliVersion` the operator config carries (#3293's `LaunchConfig`, consumed read-only).
 *
 * The one non-obvious thing: when a pin IS present it FAILS FAST, before any tracker or session
 * launch. Channels are a research preview whose behavior varies across CLI versions, so a drift
 * between the installed CLI and the pin is a stand-up to refuse, not paper over — a mismatch (or an
 * unreadable installed version) aborts with a `CliVersionAssertError` naming both versions, and a
 * match proceeds silently. The pin is OPTIONAL (issue #3417): when it is ABSENT the assert is
 * SKIPPED entirely — the installed version is accepted unread — so the crew boot stops fail-closing
 * on every frequent Claude Code auto-update. The reader of the installed version is INJECTED so the
 * launcher (#3299) wires the real `claude --version` while tests stub it; running the subprocess
 * synchronously in an `Effect.try` mirrors config.ts's `readFileSync` idiom (no new dependency).
 */
import {execFileSync} from "node:child_process";
import {Effect, Schema} from "effect";
import {CLI_VERSION_RE, type LaunchConfig} from "./config.ts";

/**
 * A version drift caught before launch: the installed CLI version does not match the pinned one, or
 * the installed version could not be read/parsed. `installed` is null when unreadable/unparseable;
 * `reason` names both versions (a fail-fast, loud, operator-facing message).
 */
export class CliVersionAssertError extends Schema.TaggedErrorClass<CliVersionAssertError>()(
	"@kampus/pipeline-crew-mcp/standup/CliVersionAssertError",
	{
		pinned: Schema.String,
		installed: Schema.NullOr(Schema.String),
		reason: Schema.String,
	},
) {}

/** Match the `major.minor.patch[-prerelease]` core anywhere in the output — the unanchored twin of config's anchored `CLI_VERSION_RE`. */
const VERSION_TOKEN_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;

/**
 * Extract the pinned-shape version token from `claude --version` output (e.g. "2.1.207 (Claude
 * Code)" → "2.1.207"), or null when none is present. The extracted token is re-validated against
 * config's `CLI_VERSION_RE` so parse accepts exactly what the pin accepts.
 */
export const parseCliVersion = (raw: string): string | null => {
	const token = raw.match(VERSION_TOKEN_RE)?.[0];
	return token !== undefined && CLI_VERSION_RE.test(token) ? token : null;
};

/**
 * The production installed-version reader: run `claude --version` and return its stdout. This is the
 * launch-side effect the assert injects by default and that tests replace with a stub — a failure
 * (binary absent, non-zero exit) surfaces as the thrown cause, which the assert maps to an error.
 */
export const readInstalledCliVersionOutput: Effect.Effect<string, string> = Effect.try({
	try: () => execFileSync("claude", ["--version"], {encoding: "utf8"}),
	catch: (cause) => String(cause),
});

/**
 * Assert the installed CLI version matches the config's pinned `cliVersion`, failing fast before any
 * launch. Reads the installed version via the injected reader (default: the real `claude --version`),
 * and yields `CliVersionAssertError` on an unreadable version, an unparseable version, or a mismatch;
 * a match returns void so the caller proceeds silently.
 *
 * The pin is optional (issue #3417): an ABSENT `cliVersion` is the "unpinned" launch — the assert is
 * skipped and the installed version accepted unread (no subprocess call), so a frequent CLI
 * auto-update never fail-closes the boot. Only a PRESENT pin runs the read/parse/exact-match below.
 */
export const assertPinnedCliVersion = (
	config: Pick<LaunchConfig, "cliVersion">,
	readVersionOutput: Effect.Effect<string, unknown> = readInstalledCliVersionOutput,
): Effect.Effect<void, CliVersionAssertError> =>
	Effect.gen(function* () {
		const pinned = config.cliVersion;
		if (pinned === undefined) return;
		const raw = yield* readVersionOutput.pipe(
			Effect.mapError(
				(cause) =>
					new CliVersionAssertError({
						pinned,
						installed: null,
						reason: `cannot read the installed Claude Code CLI version (is \`claude\` on PATH?): ${String(cause)}`,
					}),
			),
		);
		const installed = parseCliVersion(raw);
		if (installed === null) {
			return yield* new CliVersionAssertError({
				pinned,
				installed: null,
				reason: `could not parse an installed Claude Code CLI version from \`claude --version\` output: ${JSON.stringify(raw)}`,
			});
		}
		if (installed !== pinned) {
			return yield* new CliVersionAssertError({
				pinned,
				installed,
				reason: `installed Claude Code CLI ${installed} != pinned ${pinned} — channels are a research preview whose behavior varies across versions; align the installed CLI or the pinned version before stand-up`,
			});
		}
	});
