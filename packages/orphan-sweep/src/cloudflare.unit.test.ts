/**
 * `Cloudflare` over a fake `ChildProcessSpawner` — the credential-redaction regression
 * for #1141 (the leak round-1 review-code FAILed PR #1142 on). The `mockSpawner` idiom
 * mirrors `@kampus/flake-rate`'s `github-service.unit.test.ts`: drive `CloudflareLive`
 * over a canned spawner so the REAL `runCurl` / `parseJson` error paths — the ones that
 * capture the curl argv (which includes `Authorization: Bearer <token>`) into
 * `CfCommandError` / `CfParseError` — run without the network.
 *
 * The leak was: that captured argv held the raw token, and `NodeRuntime.runMain`'s
 * `logError` renders an uncaught error's fields (util.inspect), so a routine CF auth /
 * network / parse fault printed the bearer token to stderr / the CI log. These tests
 * assert the rendered error surfaces carry NONE of the raw token and DO carry the
 * `[REDACTED]` marker — they FAIL against the un-redacted code and PASS after the fix.
 */
import {inspect} from "node:util";
import {afterEach, assert, describe, it} from "@effect/vitest";
import {Cause, Effect, type Exit, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {Cloudflare, CloudflareLive} from "./cloudflare.ts";

// A real-looking secret the redaction must never let escape into a logged error field.
const TOKEN = "cf-secret-Th1s_Must_Never_Leak_0000";

const enc = new TextEncoder();

interface Canned {
	readonly stdout: string;
	readonly stderr?: string;
	readonly exitCode?: number;
}

// A spawner that ignores the command and replays one canned stdout/stderr/exit for every
// curl invocation, so `listResources` exercises the real error-capture path off-network.
const mockSpawner = (canned: Canned): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (_command) {
				return ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(1),
					stdin: Sink.drain,
					stdout: Stream.fromIterable([enc.encode(canned.stdout)]),
					stderr: Stream.fromIterable([enc.encode(canned.stderr ?? "")]),
					all: Stream.fromIterable([enc.encode(canned.stdout)]),
					exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(canned.exitCode ?? 0)),
					isRunning: Effect.succeed(false),
					kill: () => Effect.void,
					getInputFd: () => Sink.drain,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				});
			}),
		),
	);

// Creds are read from `process.env` on first method call (and `Effect.cached`), so the
// env must be set synchronously around the run; afterEach restores it.
const ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"] as const;
let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;
afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

const runList = (canned: Canned): Promise<Exit.Exit<unknown, unknown>> => {
	saved = {CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_API_TOKEN: undefined};
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	process.env.CLOUDFLARE_ACCOUNT_ID = "acct-test";
	process.env.CLOUDFLARE_API_TOKEN = TOKEN;
	return Effect.runPromiseExit(
		Cloudflare.pipe(
			Effect.flatMap((cf) => cf.listResources()),
			Effect.provide(CloudflareLive.pipe(Layer.provide(mockSpawner(canned)))),
		),
	);
};

// Every surface a rendered failure can leak through: the error's own `util.inspect` form
// (what runMain's logError prints), its JSON, and the Cause's pretty/inspect/toString.
const renderedSurfaces = (cause: Cause.Cause<unknown>): string => {
	const error = Cause.squash(cause);
	return [
		inspect(error, {depth: null}),
		(() => {
			try {
				return JSON.stringify(error);
			} catch {
				return "";
			}
		})(),
		inspect(cause, {depth: null}),
		Cause.pretty(cause),
		String(cause),
	].join("\n");
};

const assertNoLeak = (cause: Cause.Cause<unknown>) => {
	const surfaces = renderedSurfaces(cause);
	assert.isFalse(
		surfaces.includes(TOKEN),
		"raw bearer token must not appear in any rendered error surface",
	);
	assert.isTrue(surfaces.includes("[REDACTED]"), "the redaction marker must be present");
	assert.isTrue(
		surfaces.includes("Authorization: Bearer [REDACTED]"),
		"the auth header stays visible (just masked) so diagnostics still show it was present",
	);
};

describe("CloudflareLive — bearer token never reaches a logged error field (#1141 ac)", () => {
	it("a curl command failure (non-zero exit) redacts the token in CfCommandError.args", async () => {
		const exit = await runList({stdout: "", stderr: "curl: (22) 401 Unauthorized", exitCode: 22});
		assert.strictEqual(exit._tag, "Failure");
		if (exit._tag === "Failure") assertNoLeak(exit.cause);
	});

	it("a parse failure (non-JSON stdout, exit 0) redacts the token in CfParseError.args", async () => {
		const exit = await runList({stdout: "<html>500 oops</html>", stderr: "", exitCode: 0});
		assert.strictEqual(exit._tag, "Failure");
		if (exit._tag === "Failure") assertNoLeak(exit.cause);
	});
});
