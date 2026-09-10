/**
 * The sweep `hook worktree-create` runs before it provisions — that it runs, where it runs, and
 * that nothing it answers can refuse the spawn.
 *
 * Its *verdicts* are `build reap`'s and are tested there. What is at stake here is the wiring the
 * ruling turns on: whatever creates a worktree reaps first, and a reclaimer that could block a spawn
 * would be the total stop that ruling exists to end.
 */
import {Effect, Layer} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {StdinRead} from "../io/stdin.ts";
import {DEPS_NOT_PROVISIONED, WORKTREE_ADD_FAILED} from "./codes.ts";
import {REAP_LIMIT} from "./worktree-create.ts";
import {runWorktreeCreate} from "./worktree-create-verb.ts";

const REPO = "/repo";
const NAME = "agent-7f2";
const TREE = `${REPO}/.claude/worktrees/${NAME}`;
const NODE = "/usr/local/bin/node";
const ENTRY = "/repo/packages/fabrika-cli/src/bin.ts";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const envelope: Effect.Effect<StdinRead> = Effect.succeed({
	_tag: "Text",
	text: JSON.stringify({
		session_id: "80f40b22-8788-40d0-ac1c-08ab808d6086",
		transcript_path: "/home/u/.claude/projects/repo/80f40b22.jsonl",
		cwd: REPO,
		hook_event_name: "WorktreeCreate",
		name: NAME,
	}),
});

const REAP = new RegExp(`^${NODE} ${ENTRY} build reap `);
const ADD = /^git worktree add --detach /;

/** Everything the provisioning half needs to succeed, so only the sweep is under test. */
const PROVISIONS: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]> = [
	[/^git symbolic-ref /, okOut("origin/main\n")],
	[/^git fetch /, okOut("")],
	[/^git rev-parse --verify /, okOut(`${HEAD}\n`)],
	[/^git update-ref -d /, okOut("")],
	[ADD, okOut("")],
];

const PROVISIONED: FakeFsOptions = {directories: [TREE, `${TREE}/node_modules/.pnpm`]};

const run = (
	script: ReadonlyArray<readonly [RegExp, ReturnType<typeof okOut>]>,
	cli: {node: string; entry: string} | null = {node: NODE, entry: ENTRY},
	fs: FakeFsOptions = PROVISIONED,
	/** Commands the spawner cannot start at all — a binary that is not there. */
	unstartable: ReadonlyArray<RegExp> = [],
) => {
	const shell = fakeShell(script as never, undefined, unstartable);
	const disk = fakeFs(fs);
	return Effect.runPromise(
		Effect.provide(
			runWorktreeCreate({stdin: envelope, dryRun: false, env: {HOME: "/home/u"}, cli}),
			Layer.merge(shell.layer, disk.layer),
		),
	).then((out) => ({out, calls: shell.calls, cwds: shell.cwds}));
};

describe("hook worktree-create reaps before it provisions", () => {
	it("runs the sweep, bounded, before the first git command of the provisioning", async () => {
		const {out, calls} = await run([[REAP, okOut("")], ...PROVISIONS]);

		expect(out.code).toBe(0);
		const swept = calls.findIndex((line) => REAP.test(line));
		expect(swept).toBe(0);
		expect(calls[swept]).toContain(`build reap --execute --limit ${REAP_LIMIT}`);
	});

	it("runs it in the repository the envelope named, not in this process's own cwd", async () => {
		const {calls, cwds} = await run([[REAP, okOut("")], ...PROVISIONS]);

		expect(cwds[calls.findIndex((line) => REAP.test(line))]).toBe(REPO);
	});

	it("provisions anyway when the sweep fails — a reclaimer may not refuse a spawn", async () => {
		const {out} = await run([
			[REAP, {ok: false, stdout: "", reason: "cannot name this clone's trunk"} as never],
			...PROVISIONS,
		]);

		expect(out.code).toBe(0);
		expect(out.stdout.trim()).toBe(TREE);
		expect(out.stderr.join("\n")).toMatch(/reap before provisioning did not finish/);
	});

	it("skips it and says so when this process cannot name its own entrypoint", async () => {
		const {out, calls} = await run([...PROVISIONS], null);

		expect(out.code).toBe(0);
		expect(calls.some((line) => REAP.test(line))).toBe(false);
		expect(out.stderr.join("\n")).toMatch(/reaped nothing before provisioning/);
	});

	it("reports the sweep's own summary line rather than re-deriving its verdicts", async () => {
		const {out} = await run([
			[REAP, {ok: false, stdout: "", reason: "fabrika build reap: 2 removed, 1 pruned"} as never],
			...PROVISIONS,
		]);

		expect(out.stderr.join("\n")).toMatch(/2 removed, 1 pruned/);
	});

	it("describes the sweep in its own terms, never as the git children it is not", async () => {
		const {out} = await run(PROVISIONS, undefined, PROVISIONED, [REAP]);

		expect(out.code).toBe(0);
		expect(out.stderr.join("\n")).toMatch(/the sweep could not start/);
		expect(out.stderr.join("\n")).not.toMatch(/could not run git/);
	});

	it("still refuses a provisioning failure of its own — the sweep changes no refusal arm", async () => {
		const failed = await run([[REAP, okOut("")], ...PROVISIONS.filter(([p]) => p !== ADD)]);
		expect(failed.out.code).toBe(WORKTREE_ADD_FAILED);

		const depless = await run([[REAP, okOut("")], ...PROVISIONS], undefined, {
			directories: [TREE],
		});
		expect(depless.out.code).toBe(DEPS_NOT_PROVISIONED);
	});
});
