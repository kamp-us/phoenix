/**
 * `hook stash-guard` around its decision core: when it probes, what it says, and that every state in
 * which it judged nothing fails open, on a code the harness cannot read as a block.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeShell, okOut, type ScriptedExec} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {
	EMPTY_STDIN,
	ENVELOPE_UNKNOWN,
	GROUND_UNKNOWN,
	HOOK_EXIT_TABLE,
	MALFORMED_ENVELOPE,
	WRONG_EVENT,
} from "./codes.ts";
import {PRETOOLUSE_BLOCKING_EXIT} from "./harness-exit.ts";
import {runStashGuard} from "./stash-guard-verb.ts";

const LINKED = okOut("/r/.git/worktrees/wt\n/r/.git\n");
const PRIMARY = okOut("/r/.git\n/r/.git\n");
const REV_PARSE = /^git rev-parse --path-format=absolute --git-dir --git-common-dir$/;

const envelope = (command: string, cwd = "/r/wt") =>
	JSON.stringify({
		hook_event_name: "PreToolUse",
		session_id: "s",
		transcript_path: "/t.jsonl",
		cwd,
		tool_name: "Bash",
		tool_input: {command},
	});

const run = async (
	stdin: StdinRead,
	probe: ScriptedExec = LINKED,
	unstartable: ReadonlyArray<RegExp> = [],
): Promise<{
	out: VerbOutcome;
	calls: ReadonlyArray<string>;
	cwds: ReadonlyArray<string | null>;
}> => {
	const shell = fakeShell([[REV_PARSE, probe]], undefined, unstartable);
	const out = await Effect.runPromise(
		Effect.provide(
			runStashGuard({stdin: Effect.succeed(stdin), env: {PATH: "/usr/bin"}}),
			shell.layer,
		),
	);
	return {out, calls: shell.calls, cwds: shell.cwds};
};

const text = (value: string): StdinRead => ({_tag: "Text", text: value});

const decisionOf = (out: VerbOutcome): Record<string, unknown> | undefined =>
	(JSON.parse(out.stdout) as {hookSpecificOutput?: Record<string, unknown>}).hookSpecificOutput;

describe("the verdict", () => {
	it("denies a git stash in a linked worktree, at exit 0 through hookSpecificOutput", async () => {
		const {out, cwds} = await run(text(envelope("git -C /r/wt stash pop")));

		expect(out.code).toBe(0);
		expect(decisionOf(out)).toMatchObject({
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
		});
		expect(String(decisionOf(out)?.permissionDecisionReason)).toContain("refs/stash");
		expect(String(decisionOf(out)?.permissionDecisionReason)).toContain(
			".patterns/worktree-agent-constraints.md",
		);
		expect(cwds).toEqual(["/r/wt"]);
	});

	it("lets a git stash through where the git dir and common dir agree, with no decision", async () => {
		const {out} = await run(text(envelope("git stash", "/r")), PRIMARY);

		expect(out.code).toBe(0);
		expect(decisionOf(out)).toBeUndefined();
		expect(JSON.parse(out.stdout)).toMatchObject({fabrika: {outcome: "allow"}});
	});

	it("runs no git at all for a command with no git stash in it", async () => {
		const {out, calls} = await run(text(envelope("git status && pnpm test")));

		expect(out.code).toBe(0);
		expect(decisionOf(out)).toBeUndefined();
		expect(calls).toEqual([]);
	});
});

describe("the states in which nothing was judged fail open, and say so", () => {
	const cases: ReadonlyArray<readonly [string, () => ReturnType<typeof run>, number]> = [
		["an empty stdin", () => run(text("")), EMPTY_STDIN],
		[
			"an unread fd 0",
			() => run({_tag: "Failed", reason: "read failed"} as StdinRead),
			ENVELOPE_UNKNOWN,
		],
		["bytes that are not an envelope", () => run(text("{}")), MALFORMED_ENVELOPE],
		["a relative cwd", () => run(text(envelope("git stash", "wt"))), GROUND_UNKNOWN],
		[
			"a rev-parse that fails",
			() => run(text(envelope("git stash")), errOut("fatal: not a git repository")),
			GROUND_UNKNOWN,
		],
		[
			"a cwd git cannot start in",
			() => run(text(envelope("git stash", "/gone")), LINKED, [REV_PARSE]),
			GROUND_UNKNOWN,
		],
	];

	it.each(cases)("%s", async (_label, go, code) => {
		const {out} = await go();

		expect(out.code).toBe(code);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("stash guard did NOT run");
		expect(out.stderr[0]).toContain("fabrika hook stash-guard: judged");
	});
});

describe("routing", () => {
	it("refuses an envelope for another event on WRONG_EVENT, rather than judging it", async () => {
		const {out, calls} = await run(
			text(
				JSON.stringify({
					hook_event_name: "SessionStart",
					session_id: "s",
					transcript_path: "/t",
					cwd: "/r/wt",
				}),
			),
		);

		expect(out.code).toBe(WRONG_EVENT);
		expect(calls).toEqual([]);
	});

	it("refuses a PreToolUse envelope carrying no command on WRONG_EVENT", async () => {
		const {out} = await run(
			text(
				JSON.stringify({
					hook_event_name: "PreToolUse",
					session_id: "s",
					transcript_path: "/t",
					cwd: "/r/wt",
					tool_name: "Agent",
					tool_input: {subagent_type: "general-purpose"},
				}),
			),
		);

		expect(out.code).toBe(WRONG_EVENT);
	});
});

describe("the harness's blocking code", () => {
	it("is no code this verb exits on, nor any code in the table it allocates from", () => {
		for (const code of [
			EMPTY_STDIN,
			ENVELOPE_UNKNOWN,
			MALFORMED_ENVELOPE,
			WRONG_EVENT,
			GROUND_UNKNOWN,
		]) {
			expect(code).not.toBe(PRETOOLUSE_BLOCKING_EXIT);
		}
		expect(HOOK_EXIT_TABLE.map((row) => row.code)).not.toContain(PRETOOLUSE_BLOCKING_EXIT);
	});
});
