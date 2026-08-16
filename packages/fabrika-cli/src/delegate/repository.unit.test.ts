/**
 * Real directories rather than {@link fakeFs}: the subject is the difference between a `.git`
 * directory and a `.git` file, which is a filesystem fact, and a fake that scripted the answer would
 * be asserting against the very thing under test.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {realPath} from "../io/fs.ts";
import {gitFileTarget, relateCopy, repositoryOf} from "./repository.ts";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "fabrika-repository-"));
});

afterEach(() => rmSync(scratch, {recursive: true, force: true}));

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

/** An assertion compares what the subject compares — macOS `/tmp` is a symlink to `/private/tmp`. */
const real = (path: string) => run(realPath(path));

/** A primary checkout: a real `.git` directory, which is its own common dir. */
const primary = (name: string): string => {
	const root = join(scratch, name);
	mkdirSync(join(root, ".git"), {recursive: true});
	return root;
};

/** A linked working tree of `of`, wired the way `git worktree add` wires one. */
const worktree = (of: string, name: string): string => {
	const root = join(scratch, name);
	const gitDir = join(of, ".git", "worktrees", name);
	mkdirSync(root, {recursive: true});
	mkdirSync(gitDir, {recursive: true});
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
	return root;
};

describe("gitFileTarget", () => {
	it("reads the git dir out of a `.git` file, trailing newline and all", () => {
		expect(gitFileTarget("gitdir: /repo/.git/worktrees/lane\n")).toBe("/repo/.git/worktrees/lane");
	});

	it("answers undefined for text that is not a git file — never an empty path", () => {
		expect(gitFileTarget("ref: refs/heads/main\n")).toBeUndefined();
		expect(gitFileTarget("gitdir:\n")).toBeUndefined();
	});
});

describe("repositoryOf", () => {
	it("answers a primary checkout's own `.git` directory", async () => {
		const root = primary("main");
		expect(await run(repositoryOf(root))).toBe(await real(join(root, ".git")));
	});

	it("follows a worktree's `.git` file through `commondir` to the SHARED common dir", async () => {
		const of = primary("main");
		const lane = worktree(of, "lane");
		expect(await run(repositoryOf(lane))).toBe(await run(repositoryOf(of)));
	});

	it("falls back to the named git dir when no `commondir` sits beside it", async () => {
		const root = join(scratch, "separate");
		const gitDir = join(scratch, "elsewhere.git");
		mkdirSync(root, {recursive: true});
		mkdirSync(gitDir, {recursive: true});
		writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
		expect(await run(repositoryOf(root))).toBe(await real(gitDir));
	});

	it("answers undefined for a tree that is not a git checkout at all", async () => {
		const root = join(scratch, "plain");
		mkdirSync(root, {recursive: true});
		expect(await run(repositoryOf(root))).toBeUndefined();
	});

	/** A pruned worktree leaves its `.git` file behind; an unprovable repository is not a shared one. */
	it("answers undefined when the `.git` file points at a git dir that is gone", async () => {
		const root = join(scratch, "stale");
		mkdirSync(root, {recursive: true});
		writeFileSync(join(root, ".git"), `gitdir: ${join(scratch, "pruned", "worktrees", "gone")}\n`);
		expect(await run(repositoryOf(root))).toBeUndefined();
	});
});

describe("relateCopy", () => {
	it("reads an installed copy as same-repository — it belongs to no repo to cross out of", async () => {
		expect(await run(relateCopy({_tag: "no-checkout"}, primary("main")))).toEqual({
			_tag: "same-repository",
		});
	});

	it("reads the cwd's OWN checkout as same-repository without touching git at all", async () => {
		expect(await run(relateCopy({_tag: "checkout", root: "/repo"}, "/repo"))).toEqual({
			_tag: "same-repository",
		});
	});

	/** The defect #5679 names: the copy on `PATH` lives in the primary, the cwd is in a worktree. */
	it("reads two working trees of ONE repository as same-repository", async () => {
		const of = primary("main");
		const lane = worktree(of, "lane");
		expect(await run(relateCopy({_tag: "checkout", root: of}, lane))).toEqual({
			_tag: "same-repository",
		});
	});

	it("reads two unrelated repositories as other-repository, naming the copy's checkout", async () => {
		const mine = primary("mine");
		const theirs = primary("theirs");
		expect(await run(relateCopy({_tag: "checkout", root: mine}, theirs))).toEqual({
			_tag: "other-repository",
			checkout: mine,
		});
	});

	it("refuses to call a non-git tree the same repository — an unprovable peer is a foreign one", async () => {
		const mine = primary("mine");
		const plain = join(scratch, "plain");
		mkdirSync(plain, {recursive: true});
		expect(await run(relateCopy({_tag: "checkout", root: mine}, plain))).toEqual({
			_tag: "other-repository",
			checkout: mine,
		});
	});
});
