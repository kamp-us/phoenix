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

// `curl -w` appends the status marker after the body (see `cloudflare.ts` `HTTP_STATUS_MARKER`);
// the mock spawner replays a CANNED stdout, so a test that wants `runCurlOk` to read a given
// HTTP status must stitch that same marker on itself.
const withStatus = (body: string, code: number): string => `${body}\nHTTP_STATUS:${code}`;

const handleFor = (canned: Canned) =>
	ChildProcessSpawner.makeHandle({
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

// A spawner that ignores the command and replays one canned stdout/stderr/exit for every
// curl invocation, so `listResources` exercises the real error-capture path off-network.
const mockSpawner = (canned: Canned): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make((_command) => Effect.sync(() => handleFor(canned))),
	);

// A spawner that replays a SEQUENCE of canned responses across successive curl invocations
// (the last entry repeats once the queue drains), so a test can drive "429 on the first call,
// success on the retry" through the real `runCurlOk` retry path. `Effect.all` runs the list
// calls sequentially, so invocation order is deterministic.
const sequenceSpawner = (
	responses: ReadonlyArray<Canned>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> => {
	let calls = 0;
	return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make((_command) =>
			Effect.sync(() => {
				const canned = responses[Math.min(calls, responses.length - 1)] ?? {stdout: ""};
				calls += 1;
				return handleFor(canned);
			}),
		),
	);
};

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

const runListSeq = (responses: ReadonlyArray<Canned>): Promise<Exit.Exit<unknown, unknown>> => {
	saved = {CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_API_TOKEN: undefined};
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	process.env.CLOUDFLARE_ACCOUNT_ID = "acct-test";
	process.env.CLOUDFLARE_API_TOKEN = TOKEN;
	return Effect.runPromiseExit(
		Cloudflare.pipe(
			Effect.flatMap((cf) => cf.listResources()),
			Effect.provide(CloudflareLive.pipe(Layer.provide(sequenceSpawner(responses)))),
		),
	);
};

const EMPTY_OK = withStatus(`{"success":true,"errors":[],"result":[]}`, 200);

// Every surface a rendered failure can leak through: the error's own `util.inspect` form
// (what runMain's logError prints), its JSON, and the Cause's pretty/inspect/toString.
const renderedSurfaces = (cause: Cause.Cause<unknown>): string => {
	const error = Cause.squash(cause);
	return [
		inspect(error, {depth: null}),
		(() => {
			// biome-ignore lint/plugin: pure total test helper — JSON.stringify can throw on a circular error object; the failure is fully absorbed into "" (one of the leak-surface strings being collected), never the E channel, so this is not Effect control flow to model.
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

	it("a parse failure (non-JSON 200 body) redacts the token in CfParseError.args", async () => {
		// A 200 with a non-JSON body clears the `runCurlOk` status gate and fails in `parseJson`.
		const exit = await runList({stdout: withStatus("<html>500 oops</html>", 200), exitCode: 0});
		assert.strictEqual(exit._tag, "Failure");
		if (exit._tag === "Failure") assertNoLeak(exit.cause);
	});
});

describe("CloudflareLive — transient-fault resilience + error surfacing (#1506)", () => {
	it("retries a transient 429 then completes the list (the 210-app fan-out survives a rate limit)", async () => {
		// First curl invocation (listWorkers GET) returns a 429; the bounded backoff re-drives
		// it, every later call returns an empty success — so the whole list completes (no abort).
		const exit = await runListSeq([
			{stdout: withStatus(`{"success":false,"errors":[{"code":10000}],"result":null}`, 429)},
			{stdout: EMPTY_OK},
		]);
		assert.strictEqual(exit._tag, "Success");
		if (exit._tag === "Success") assert.deepStrictEqual(exit.value, []);
	});

	it("surfaces the real status + CF error body on a non-retryable HTTP failure (no opaque empty error)", async () => {
		// A 403 is NOT retryable: it must fail FAST and carry both the status and the CF error
		// body, instead of the opaque empty `CfCommandError` `curl -f` produced (#1506).
		const cfBody = `{"success":false,"errors":[{"code":9109,"message":"Invalid access token"}]}`;
		const exit = await runListSeq([{stdout: withStatus(cfBody, 403)}]);
		assert.strictEqual(exit._tag, "Failure");
		if (exit._tag === "Failure") {
			const surfaces = renderedSurfaces(exit.cause);
			assert.isTrue(surfaces.includes("403"), "the HTTP status is surfaced");
			assert.isTrue(surfaces.includes("Invalid access token"), "the CF error body is surfaced");
			// The token lives only in the request argv, never in a CfHttpError — assert it still cannot leak.
			assert.isFalse(surfaces.includes(TOKEN), "the bearer token must not appear in the error");
		}
	});

	it("tolerates a per-app flags 404 — the app is still swept and the enumeration does not abort", async () => {
		// listWorkers (empty) → listD1 (empty) → listFlagship apps (one prefixed app) → that app's
		// /flags sub-resource 404s (the app exists in the apps list but is mid-deletion / in a
		// no-flags state). The 404 folds to zero flags, the app is STILL emitted as a flagship-app
		// resource, and the whole 210-app-style fan-out COMPLETES instead of aborting (#1506).
		const APP_ID = "app-404-flags";
		const APP_NAME = "phoenix-phoenix-flags-pr-999";
		const exit = await runListSeq([
			{stdout: EMPTY_OK}, // listWorkers
			{stdout: EMPTY_OK}, // listD1
			{
				stdout: withStatus(
					`{"success":true,"errors":[],"result":[{"id":"${APP_ID}","name":"${APP_NAME}"}]}`,
					200,
				),
			}, // listFlagship apps
			{
				stdout: withStatus(
					`{"success":false,"errors":[{"code":7003,"message":"Could not route to flags"}],"result":null}`,
					404,
				),
			}, // the app's /flags sub-resource → 404
		]);
		assert.strictEqual(exit._tag, "Success");
		if (exit._tag === "Success") {
			assert.deepStrictEqual(exit.value, [{kind: "flagship-app", name: APP_NAME, appId: APP_ID}]);
		}
	});
});
