/**
 * `createWorktree`'s order: what runs inside the creation lock, what runs after it, and that every
 * exit leaves the lock free.
 *
 * The filesystem is real (a temp dir) so the lock is a real directory the spawner can look at; git
 * is scripted, and each scripted command records whether the lock was held when it ran. That is the
 * only way to hold "the install ran outside the lock" as a fact rather than as a reading of the code.
 */
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeFileSystem} from "@effect/platform-node";
import {Effect, Layer, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {afterAll, describe, expect, it} from "vitest";
import type {VerbOutcome} from "../verb.ts";
import {
	BASE_FETCH_FAILED,
	CREATION_LOCK_UNAVAILABLE,
	DEPS_NOT_PROVISIONED,
	WORKTREE_ADD_FAILED,
} from "./codes.ts";
import {type LockHost, lockDirFor, stampOf} from "./creation-lock.ts";
import {planWorktree, type WorktreePlan} from "./worktree-create.ts";
import {createWorktree} from "./worktree-owner.ts";

const HEAD = "a".repeat(40);
const enc = new TextEncoder();

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, {recursive: true, force: true});
});

interface Ran {
	readonly line: string;
	readonly cwd: string | undefined;
	/** Whether the creation lock existed on disk when this command ran. */
	readonly locked: boolean;
}

type Reply = {readonly ok: boolean; readonly stdout?: string; readonly stderr?: string};

/** What each git command answers; a command no row matches fails as unscripted. */
type Script = ReadonlyArray<readonly [RegExp, (cwd: string | undefined) => Reply]>;

const spawner = (script: Script, lockDir: string, ran: Ran[]) =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
		ChildProcessSpawner.make(
			Effect.fnUntraced(function* (command) {
				const std = command._tag === "StandardCommand" ? command : undefined;
				const line = std === undefined ? "<piped>" : [std.command, ...std.args].join(" ");
				const cwd = std?.options.cwd;
				ran.push({line, cwd, locked: existsSync(lockDir)});
				const reply = script.find(([pattern]) => pattern.test(line))?.[1](cwd) ?? {
					ok: false,
					stderr: "unscripted command",
				};
				return ChildProcessSpawner.makeHandle({
					pid: ChildProcessSpawner.ProcessId(1),
					stdin: Sink.drain,
					stdout: Stream.fromIterable([enc.encode(reply.stdout ?? "")]),
					stderr: Stream.fromIterable([enc.encode(reply.stderr ?? "")]),
					all: Stream.fromIterable([enc.encode(`${reply.stdout ?? ""}${reply.stderr ?? ""}`)]),
					exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(reply.ok ? 0 : 1)),
					isRunning: Effect.succeed(false),
					kill: () => Effect.void,
					getInputFd: () => Sink.drain,
					getOutputFd: () => Stream.empty,
					unref: Effect.succeed(Effect.void),
				});
			}),
		),
	);

interface Ground {
	readonly plan: WorktreePlan;
	readonly commonDir: string;
	readonly lockDir: string;
}

const ground = (): Ground => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-create-worktree-"));
	roots.push(root);
	const repo = join(root, "repo");
	const commonDir = join(repo, ".git");
	mkdirSync(commonDir, {recursive: true});
	const planned = planWorktree({cwd: repo, name: "agent-7f2"});
	if (planned._tag !== "Plan") throw new Error(planned.reason);
	return {plan: planned.plan, commonDir, lockDir: lockDirFor(commonDir)};
};

const ok =
	(stdout = ""): (() => Reply) =>
	() => ({ok: true, stdout});
const fail =
	(stderr: string): (() => Reply) =>
	() => ({ok: false, stderr});

/** A clone where every step succeeds: the add makes the tree and the install makes its store. */
const healthy = ({plan, commonDir}: Ground): Script => [
	[/^git rev-parse --path-format=absolute --git-common-dir$/, ok(`${commonDir}\n`)],
	[/^git symbolic-ref /, ok("origin/main\n")],
	[/^git fetch /, ok()],
	[/^git rev-parse --verify /, ok(`${HEAD}\n`)],
	[/^git update-ref -d /, ok()],
	[
		/^git -c core\.hooksPath=\/dev\/null worktree add --detach /,
		() => {
			mkdirSync(plan.worktreePath, {recursive: true});
			return {ok: true};
		},
	],
	[
		/^git hook run --ignore-missing post-checkout -- /,
		(cwd) => {
			mkdirSync(join(cwd ?? "/nonexistent", "node_modules", ".pnpm"), {recursive: true});
			return {ok: true};
		},
	],
];

/** Replace the row whose pattern names `step` — the one step a test breaks. */
const breaking = (
	script: Script,
	step: string,
	reply: (cwd: string | undefined) => Reply,
): Script =>
	script.map(
		([pattern, answer]) => [pattern, pattern.source.includes(step) ? reply : answer] as const,
	);

const NOBODY_ALIVE: LockHost = {pid: 4242, host: "this-host", now: Date.now, alive: () => false};

const create = (
	g: Ground,
	script: Script,
	host: LockHost = NOBODY_ALIVE,
	waitBudgetMs = 0,
): Promise<{out: VerbOutcome; ran: ReadonlyArray<Ran>}> => {
	const ran: Ran[] = [];
	return Effect.runPromise(
		createWorktree(g.plan, {}, "0123456789ab", host, waitBudgetMs).pipe(
			Effect.provide(Layer.merge(spawner(script, g.lockDir, ran), NodeFileSystem.layer)),
		),
	).then((out) => ({out, ran}));
};

const find = (ran: ReadonlyArray<Ran>, pattern: RegExp): Ran => {
	const hit = ran.find((r) => pattern.test(r.line));
	if (hit === undefined)
		throw new Error(`no command matched ${pattern}: ${ran.map((r) => r.line)}`);
	return hit;
};

describe("createWorktree", () => {
	it("holds the lock for the fetch and the add, and installs after releasing it", async () => {
		const g = ground();
		const {out, ran} = await create(g, healthy(g));

		expect(out.code).toBe(0);
		expect(out.stdout).toBe(`${g.plan.worktreePath}\n`);
		expect(find(ran, /^git fetch /).locked).toBe(true);
		expect(find(ran, /worktree add --detach/).locked).toBe(true);
		expect(find(ran, /^git hook run /).locked).toBe(false);
		expect(existsSync(g.lockDir)).toBe(false);
	});

	it("reads the common dir and the default branch before taking the lock", async () => {
		const g = ground();
		const {ran} = await create(g, healthy(g));

		expect(find(ran, /--git-common-dir$/).locked).toBe(false);
		expect(find(ran, /^git symbolic-ref /).locked).toBe(false);
	});

	it("adds with hooks off, then fires post-checkout itself in the new tree with add's arguments", async () => {
		const g = ground();
		const {ran} = await create(g, healthy(g));

		const add = find(ran, /worktree add --detach/);
		expect(add.line).toBe(
			`git -c core.hooksPath=/dev/null worktree add --detach ${g.plan.worktreePath} ${HEAD}`,
		);
		const install = find(ran, /^git hook run /);
		expect(install.line).toBe(
			`git hook run --ignore-missing post-checkout -- ${"0".repeat(40)} ${HEAD} 1`,
		);
		expect(install.cwd).toBe(g.plan.worktreePath);
		expect(ran.indexOf(install)).toBeGreaterThan(ran.indexOf(add));
	});

	it.each([
		[
			"the fetch fails",
			"git fetch",
			fail("fatal: Could not read from remote repository."),
			BASE_FETCH_FAILED,
		],
		["the base resolves to nothing", "--verify", ok(""), BASE_FETCH_FAILED],
		["the add fails", "worktree add", fail("fatal: '/x' already exists"), WORKTREE_ADD_FAILED],
		["the add exits 0 and builds no tree", "worktree add", ok(), WORKTREE_ADD_FAILED],
		["the install writes no store", "hook run", ok(), DEPS_NOT_PROVISIONED],
	])("releases the lock and prints no path when %s", async (_label, which, reply, code) => {
		const g = ground();
		const {out} = await create(g, breaking(healthy(g), which, reply));

		expect(out.code).toBe(code);
		expect(out.stdout).toBe("");
		expect(existsSync(g.lockDir)).toBe(false);
	});

	it("names a failed install on the dep-less refusal", async () => {
		const g = ground();
		const {out} = await create(
			g,
			breaking(healthy(g), "hook run", fail("bootstrap-deps: pnpm exited 1")),
		);

		expect(out.code).toBe(DEPS_NOT_PROVISIONED);
		expect(out.stderr.join("\n")).toContain("the install failed: bootstrap-deps: pnpm exited 1");
	});

	it("refuses before any fetch when the common dir cannot be read", async () => {
		const g = ground();
		const {out, ran} = await create(
			g,
			breaking(healthy(g), "git-common-dir", fail("fatal: not a git repository")),
		);

		expect(out.code).toBe(CREATION_LOCK_UNAVAILABLE);
		expect(ran.some((r) => r.line.startsWith("git fetch"))).toBe(false);
	});

	it("refuses without fetching when a live holder keeps the lock past the wait", async () => {
		const g = ground();
		mkdirSync(g.lockDir, {recursive: true});
		const stamp = stampOf({id: "sibling", pid: 777, host: "this-host", at: Date.now()});
		writeFileSync(join(g.lockDir, "holder"), stamp);

		const {out, ran} = await create(g, healthy(g), {...NOBODY_ALIVE, alive: (pid) => pid === 777});

		expect(out.code).toBe(CREATION_LOCK_UNAVAILABLE);
		expect(out.stdout).toBe("");
		expect(out.stderr.join("\n")).toContain("pid 777 on this-host");
		expect(ran.some((r) => r.line.startsWith("git fetch"))).toBe(false);
		// The live holder's lock is left exactly as it was.
		expect(existsSync(join(g.lockDir, "holder"))).toBe(true);
	});

	it("takes over a lock whose holder died, and provisions", async () => {
		const g = ground();
		mkdirSync(g.lockDir, {recursive: true});
		writeFileSync(
			join(g.lockDir, "holder"),
			stampOf({id: "dead", pid: 777, host: "this-host", at: Date.now()}),
		);

		const {out} = await create(g, healthy(g));

		expect(out.code).toBe(0);
		expect(existsSync(g.lockDir)).toBe(false);
	});
});
