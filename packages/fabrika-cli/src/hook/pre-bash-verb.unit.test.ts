/**
 * `hook pre-bash` around its decision core: what it arms on, what it says, and how it says it.
 *
 * The wire shape is asserted as hard as the verdict. A deny that spelled `permissionDecision` wrong
 * is a guard the harness silently ignores, and an allow that spelled it `"allow"` would hand every
 * Bash command a permission bypass the operator never granted — two failures that look identical in
 * a test asserting only the exit code.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {ENVELOPE_UNKNOWN, GROUND_UNKNOWN, MALFORMED_ENVELOPE, WRONG_EVENT} from "./codes.ts";
import {PRETOOLUSE_BLOCKING_EXIT} from "./harness-exit.ts";
import {runPreBash} from "./pre-bash-verb.ts";

const PRIMARY = "/primary";
const WORKTREE = "/wt";

/** A primary checkout plus one linked worktree whose `.git` file and `commondir` point home. */
const repoFs = () =>
	fakeFs({
		directories: [`${PRIMARY}/.git`],
		dirs: {[PRIMARY]: [".git"], [`${PRIMARY}/.git/worktrees/wt`]: []},
		files: {
			[`${WORKTREE}/.git`]: "gitdir: /primary/.git/worktrees/wt",
			[`${PRIMARY}/.git/worktrees/wt/commondir`]: "../..",
		},
	});

const envelope = (command: string, cwd: string) =>
	JSON.stringify({
		hook_event_name: "PreToolUse",
		session_id: "s",
		transcript_path: "/t.jsonl",
		cwd,
		tool_name: "Bash",
		tool_input: {command},
	});

const run = (
	text: string,
	fs = repoFs(),
	env: Record<string, string | undefined> = {HOME: "/Users/operator"},
): Promise<VerbOutcome> =>
	Effect.runPromise(
		Effect.provide(
			runPreBash({stdin: Effect.succeed({_tag: "Text", text} as StdinRead), env}),
			fs.layer,
		),
	);

const decisionOf = (out: VerbOutcome): Record<string, unknown> =>
	(JSON.parse(out.stdout) as {hookSpecificOutput?: Record<string, unknown>}).hookSpecificOutput ??
	{};

describe("the verdict on the wire", () => {
	it("denies an escaping jump through hookSpecificOutput, at exit 0 — never the blocking code", async () => {
		const out = await run(envelope(`cd ${PRIMARY} && node bin.ts build branch 1`, WORKTREE));

		expect(out.code).toBe(0);
		expect(out.code).not.toBe(PRETOOLUSE_BLOCKING_EXIT);
		expect(decisionOf(out)).toMatchObject({
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
		});
		expect(String(decisionOf(out).permissionDecisionReason)).toContain(WORKTREE);
	});

	it("carries NO permissionDecision on an allow — `allow` would bypass the operator's own rules", async () => {
		const out = await run(envelope("pnpm vitest run", WORKTREE));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).not.toHaveProperty("hookSpecificOutput");
		expect(JSON.parse(out.stdout)).toMatchObject({fabrika: {outcome: "allow"}});
	});
});

describe("what the guard arms on", () => {
	it("judges nothing in the primary checkout — isolation is the operator's call", async () => {
		const out = await run(envelope(`cd /elsewhere && git switch main`, PRIMARY));

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({fabrika: {outcome: "allow"}});
		expect(out.stderr.join("\n")).toContain("primary checkout");
	});

	it("allows a cwd under no working tree — there is nothing to escape from", async () => {
		const out = await run(envelope("cd /somewhere-else && ls", "/scratch/deep"), fakeFs({}));

		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toContain("nothing to escape from");
	});
});

describe("the states in which nothing was judged", () => {
	it("fails open and loud when the cwd's working tree cannot be established", async () => {
		const out = await run(
			envelope(`cd ${PRIMARY} && node bin.ts`, WORKTREE),
			fakeFs({unprobeable: [`${WORKTREE}/.git`]}),
		);

		expect(out.code).toBe(GROUND_UNKNOWN);
		expect(out.code).not.toBe(PRETOOLUSE_BLOCKING_EXIT);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("proceeds unguarded");
	});

	it("refuses a payload that is not an envelope, and an unread fd 0, on separate codes", async () => {
		const malformed = await run("{}");
		const unknown = await Effect.runPromise(
			Effect.provide(
				runPreBash({
					stdin: Effect.succeed({_tag: "Failed", reason: "read failed"} as StdinRead),
					env: {},
				}),
				repoFs().layer,
			),
		);

		expect(malformed.code).toBe(MALFORMED_ENVELOPE);
		expect(unknown.code).toBe(ENVELOPE_UNKNOWN);
	});

	it("refuses an event it does not judge, and a payload carrying no command", async () => {
		const wrongEvent = await run(
			JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "s",
				transcript_path: "/t",
				cwd: WORKTREE,
			}),
		);
		const noCommand = await run(
			JSON.stringify({
				hook_event_name: "PreToolUse",
				session_id: "s",
				transcript_path: "/t",
				cwd: WORKTREE,
				tool_name: "Agent",
				tool_input: {subagent_type: "general-purpose"},
			}),
		);

		expect(wrongEvent.code).toBe(WRONG_EVENT);
		expect(noCommand.code).toBe(WRONG_EVENT);
		expect(noCommand.stderr.join("\n")).toContain("tool_input.command");
	});
});
