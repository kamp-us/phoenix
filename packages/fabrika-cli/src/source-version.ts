/**
 * The reader behind `fabrika --version`'s source suffix.
 *
 * Git runs only when argv asks for the version and this module is the `.ts` source, never the
 * compiled `dist` copy. It reads the checkout this package lives in, found from `import.meta.url`,
 * so a cwd inside some other repository cannot lend its commit. Every failure, including a git that
 * does not answer within {@link SOURCE_READ_BOUND}, prints the plain version.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10099
 */
import {fileURLToPath} from "node:url";
import {Duration, Effect, Option} from "effect";
import {execCapture} from "./io/exec.ts";
import type {Shell} from "./io/git.ts";
import {displayVersion, type SourceReading, VERSION} from "./version.ts";

export const SOURCE_READ_BOUND = Duration.seconds(2);

/** Whether argv reaches Effect CLI's built-in `--version` / `-v` flag before an end-of-options `--`. */
export const asksForVersion = (argv: ReadonlyArray<string>): boolean => {
	for (const arg of argv) {
		if (arg === "--") return false;
		if (arg === "--version" || arg === "-v" || arg.startsWith("--version=")) return true;
	}
	return false;
};

/** A source run loads `.ts` modules; the published build loads `dist/*.js`. */
export const isSourceModule = (moduleUrl: string): boolean =>
	new URL(moduleUrl).pathname.endsWith(".ts");

const SHORT_SHA = /^[0-9a-f]{4,64}$/;

/** The commit and tracked-change state of the checkout holding `dir`, or `null` on any failure. */
export const readSource = (dir: string): Shell<SourceReading | null> =>
	Effect.gen(function* () {
		const head = yield* execCapture("git", ["-C", dir, "rev-parse", "--short", "HEAD"]);
		const sha = head.stdout.trim();
		if (!head.ok || !SHORT_SHA.test(sha)) return null;
		const status = yield* execCapture("git", [
			"-C",
			dir,
			"status",
			"--porcelain",
			"--untracked-files=no",
		]);
		if (!status.ok) return null;
		return {sha, dirty: status.stdout.trim() !== ""};
	}).pipe(Effect.timeoutOption(SOURCE_READ_BOUND), Effect.map(Option.getOrNull));

/** The version string to hand `Command.run` for this invocation. */
export const versionFor = (
	argv: ReadonlyArray<string>,
	moduleUrl: string = import.meta.url,
): Shell<string> =>
	asksForVersion(argv) && isSourceModule(moduleUrl)
		? readSource(fileURLToPath(new URL("..", moduleUrl))).pipe(
				Effect.map((reading) => displayVersion(VERSION, reading)),
			)
		: Effect.succeed(VERSION);
