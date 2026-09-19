/**
 * Where the reason sits on a `hook plugin-sync` refusal's stderr.
 *
 * A failed `SessionStart` hook shows the session one line, so the pin is on `stderr[0]` of every
 * refusal path and nowhere else: an assertion that merely found the reason *somewhere* would have
 * passed against the eight-line replay whose reason came last.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9460
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {
	EMPTY_STDIN,
	ENVELOPE_UNKNOWN,
	FAST_FORWARD_FAILED,
	GROUND_UNKNOWN,
	MALFORMED_ENVELOPE,
	REMOTE_UNREADABLE,
	SYNC_REFUSED,
	WRONG_EVENT,
} from "./codes.ts";
import {runPluginSync} from "./plugin-sync-verb.ts";

const ROOT = "/src";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REMOTE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STALE = "cccccccccccccccccccccccccccccccccccccccc";
const OLDER = "dddddddddddddddddddddddddddddddddddddddd";
const SCOPE = `fabrika hook plugin-sync: judging the plugin source at ${ROOT}`;

const envelope = (event = "SessionStart"): string =>
	JSON.stringify({
		hook_event_name: event,
		session_id: "s1",
		transcript_path: "/transcripts/s1.jsonl",
		cwd: `${ROOT}/packages/fabrika-cli`,
	});

const piped = (text: string): StdinRead => ({_tag: "Text", text});

type Script = ReadonlyArray<readonly [RegExp, ExecResult]>;

/** Every git read the verb makes on the way to a plan, answered so it reaches one. */
const reachesThePlan = (dirty: boolean): Script => [
	[/--git-common-dir/, okOut(`${ROOT}/.git`)],
	[/symbolic-ref --short refs\/remotes\/origin\/HEAD/, okOut("origin/main")],
	[/^git fetch/, okOut("")],
	[/symbolic-ref --quiet --short HEAD/, okOut("main")],
	[/rev-parse HEAD/, okOut(HEAD)],
	[/rev-parse refs\/remotes\/origin\/main/, okOut(REMOTE)],
	[/status --porcelain/, okOut(dirty ? " M skills/build/SKILL.md" : "")],
	[/merge-base --is-ancestor/, okOut("")],
	[/^git merge --ff-only/, okOut("")],
];

/** Harness records that name two installs still copied from commits before {@link HEAD}. */
const LAGGING_RECORDS = {
	"/config/plugins/known_marketplaces.json": JSON.stringify({
		local: {source: {source: "directory", path: ROOT}},
	}),
	"/config/plugins/installed_plugins.json": JSON.stringify({
		plugins: {
			"fabrika@local": [{gitCommitSha: STALE}, {gitCommitSha: STALE}],
			"toolkit@local": [{gitCommitSha: OLDER}],
		},
	}),
};

const run = (
	options: {
		readonly stdin?: StdinRead;
		readonly script?: Script;
		readonly dryRun?: boolean;
		readonly files?: Readonly<Record<string, string>>;
	} = {},
): Promise<VerbOutcome> => {
	const shell = fakeShell([...(options.script ?? reachesThePlan(false))]);
	const fs = fakeFs({files: {...options.files}});
	return Effect.runPromise(
		Effect.provide(
			runPluginSync({
				stdin: Effect.succeed(options.stdin ?? piped(envelope())),
				dryRun: options.dryRun ?? false,
				env: {CLAUDE_CONFIG_DIR: "/config", PATH: "/usr/bin"},
			}),
			Layer.mergeAll(shell.layer, fs.layer),
		),
	);
};

/** One arm per `refuse(...)` path in `runPluginSync`, each named by what it must lead with. */
const paths = [
	[
		"stdin held nothing",
		EMPTY_STDIN,
		"stdin was read and held no SessionStart envelope",
		{stdin: piped("")},
	],
	[
		"fd 0 could not be read",
		ENVELOPE_UNKNOWN,
		"envelope UNKNOWN — the pipe stalled",
		{stdin: {_tag: "Failed", reason: "the pipe stalled"} as StdinRead},
	],
	[
		"the bytes are not an envelope",
		MALFORMED_ENVELOPE,
		"not a hook envelope — not JSON",
		{stdin: piped("{nope")},
	],
	[
		"the envelope is another event",
		WRONG_EVENT,
		"judges SessionStart and the envelope is PreToolUse",
		{stdin: piped(envelope("PreToolUse"))},
	],
	[
		"the cwd names no clone",
		GROUND_UNKNOWN,
		"names no clone whose primary worktree this verb can read",
		{script: [[/--git-common-dir/, errOut("fatal: not a git repository")] as const]},
	],
	[
		"the remote could not be fetched",
		REMOTE_UNREADABLE,
		"could not fetch origin/main",
		{
			script: [
				[/^git fetch/, errOut("fatal: unable to access origin")] as const,
				...reachesThePlan(false),
			],
		},
	],
	[
		"the checkout's own state could not be read",
		GROUND_UNKNOWN,
		"fetched origin/main and could not read this checkout's own state",
		{
			script: [
				[/rev-parse HEAD/, errOut("fatal: bad revision")] as const,
				...reachesThePlan(false),
			],
		},
	],
	[
		"the checkout is in no state to advance",
		SYNC_REFUSED,
		"carries uncommitted changes",
		{script: reachesThePlan(true), files: LAGGING_RECORDS},
	],
	[
		"the planned fast-forward failed",
		FAST_FORWARD_FAILED,
		"passed every precondition and the fast-forward failed",
		{
			script: [
				[/^git merge --ff-only/, errOut("fatal: refusing to merge")] as const,
				...reachesThePlan(false),
			],
		},
	],
] as const;

describe("a plugin-sync refusal", () => {
	it.each(paths)("leads stderr with its reason when %s", async (_arm, code, reason, options) => {
		const outcome = await run(options);
		expect(outcome.code).toBe(code);
		expect(outcome.stderr[0]).toContain(reason);
	});

	it("never leads with the scope line, whichever path refused", async () => {
		for (const [, , , options] of paths) {
			const outcome = await run(options);
			expect(outcome.stderr[0]).not.toBe(SCOPE);
		}
	});

	it("keeps the scope line and every install-binding line, behind the reason", async () => {
		const outcome = await run({script: reachesThePlan(true), files: LAGGING_RECORDS});
		expect(outcome.stderr[0]).toContain("carries uncommitted changes");
		expect(outcome.stderr.slice(1)).toEqual([
			SCOPE,
			expect.stringContaining("2 install binding(s) are still copied from an earlier commit"),
			expect.stringContaining(`fabrika@local bound at ${STALE.slice(0, 12)} by 2 scope record(s)`),
			expect.stringContaining(`toolkit@local bound at ${OLDER.slice(0, 12)} by 1 scope record(s)`),
		]);
	});

	it("carries the evidence line it quotes, behind the reason", async () => {
		const outcome = await run({stdin: piped("{nope")});
		expect(outcome.stderr).toHaveLength(2);
		expect(outcome.stderr[1]).toContain("{nope");
	});
});

describe("a plugin-sync answer", () => {
	it("still prints scope, then the plan line, then the install lines", async () => {
		const outcome = await run({files: LAGGING_RECORDS});
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toBe(`advanced\tmain\t${REMOTE.slice(0, 12)}\n`);
		expect(outcome.stderr[0]).toBe(SCOPE);
		expect(outcome.stderr[1]).toContain(
			`fast-forwarded main ${HEAD.slice(0, 12)}..${REMOTE.slice(0, 12)}`,
		);
		expect(outcome.stderr[2]).toContain("install binding(s) are still copied");
	});
});
