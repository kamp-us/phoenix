/**
 * What git does to a base that names a branch this clone also holds locally, run against real git.
 *
 * The claim `fetchBase` rests on is git's, not this package's: that a bare `git fetch` writes
 * remote-tracking refs and leaves `refs/heads/<name>` where it was, and that `git rev-parse <name>`
 * resolves `refs/heads/<name>` before `refs/remotes/<name>`. Together those made `--base epic/7497`
 * cut off whatever this clone last integrated.   It is measured here rather than reasoned
 * about (CLAUDE.md: ground platform claims in a real run).
 *
 * What is exercised is the two argv shapes, the way `hook/worktree-base.git.test.ts` exercises
 * `worktree-create`'s: the bare fetch plus a local `rev-parse` that `git.ts`'s `fetchBase` used to
 * run for any base naming no configured remote, against the remote-and-ref fetch plus `FETCH_HEAD`
 * that its `Remote` arm runs now. That `fetchBase` has no arm left which can run the first is
 * `branch-verb.unit.test.ts`'s claim, over a scripted spawner.
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterAll, describe, expect, it} from "vitest";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";

const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

const git = (cwd: string | undefined, ...args: ReadonlyArray<string>): string =>
	execFileSync("git", [...args], {cwd, env: GIT_ENV, encoding: "utf8"}).trim();

const roots: Array<string> = [];
afterAll(() => {
	for (const root of roots) rmSync(root, {recursive: true, force: true});
	roots.length = 0;
});

const ASSEMBLY = "epic/7497";

interface Fixture {
	readonly clone: string;
	/** What the clone's own `refs/heads/epic/7497` holds — the sibling-less commit it last had. */
	readonly stale: string;
	/** What origin holds for the same branch after a sibling landed on it. */
	readonly published: string;
}

/** A clone whose local assembly branch is one commit behind the tip origin published. */
const openStaleClone = (): Fixture => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-base-ref-"));
	roots.push(root);
	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	const clone = join(root, "clone");

	git(undefined, "init", "--quiet", "--bare", "-b", "main", remote);
	git(undefined, "init", "--quiet", "-b", "main", seed);
	writeFileSync(join(seed, "a.txt"), "a");
	git(seed, "add", "-A");
	git(seed, "commit", "--quiet", "-m", "trunk");
	git(seed, "remote", "add", "origin", remote);
	git(seed, "push", "--quiet", "origin", "main");
	git(seed, "switch", "--quiet", "-c", ASSEMBLY);
	writeFileSync(join(seed, "b.txt"), "b");
	git(seed, "add", "-A");
	git(seed, "commit", "--quiet", "-m", "assembly opened");
	git(seed, "push", "--quiet", "origin", ASSEMBLY);
	const stale = git(seed, "rev-parse", "HEAD");

	git(undefined, "clone", "--quiet", remote, clone);
	git(clone, "switch", "--quiet", "-c", ASSEMBLY, `origin/${ASSEMBLY}`);
	git(clone, "switch", "--quiet", "main");

	writeFileSync(join(seed, "c.txt"), "c");
	git(seed, "add", "-A");
	git(seed, "commit", "--quiet", "-m", "a sibling landed");
	git(seed, "push", "--quiet", "origin", ASSEMBLY);

	return {clone, stale, published: git(seed, "rev-parse", "HEAD")};
};

describe("a base naming a branch this clone also holds", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("resolves stale under a bare fetch — the shape that cut four children off the wrong commit", () => {
		const {clone, stale, published} = openStaleClone();
		git(clone, "fetch", "--quiet");
		const resolved = git(clone, "rev-parse", "--verify", "--quiet", `${ASSEMBLY}^{commit}`);
		expect(resolved).toBe(stale);
		expect(resolved).not.toBe(published);
	});

	it("resolves the published tip when the remote and the ref are named", () => {
		const {clone, stale, published} = openStaleClone();
		git(clone, "fetch", "--quiet", "origin", ASSEMBLY);
		const resolved = git(clone, "rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}");
		expect(resolved).toBe(published);
		expect(resolved).not.toBe(stale);
	});

	it("leaves the local ref unmoved even after the named fetch, so the local read stays wrong", () => {
		const {clone, stale} = openStaleClone();
		git(clone, "fetch", "--quiet", "origin", ASSEMBLY);
		expect(git(clone, "rev-parse", `refs/heads/${ASSEMBLY}`)).toBe(stale);
	});
});

/**
 * What `git merge-base` does over two roots that share nothing — the claim the `36` split rests on.
 *
 * It is a *proven* "no merge base", and git spends the same non-zero exit on it that it spends on a
 * revision it could not read, with empty stdout either way. `execCapture` carries neither status, so
 * `branch-verb.ts` reads both revisions back instead; this measures that the read-back can tell them
 * apart at all — the unrelated pair resolves, the unreadable name does not.
 */
describe("merge-base over unrelated roots", {timeout: SUBPROCESS_TEST_TIMEOUT_MS}, () => {
	const openUnrelatedPair = (): {repo: string; a: string; b: string} => {
		const repo = mkdtempSync(join(tmpdir(), "fabrika-unrelated-"));
		roots.push(repo);
		git(undefined, "init", "--quiet", "-b", "main", repo);
		writeFileSync(join(repo, "a.txt"), "a");
		git(repo, "add", "-A");
		git(repo, "commit", "--quiet", "-m", "root one");
		const a = git(repo, "rev-parse", "HEAD");
		git(repo, "checkout", "--quiet", "--orphan", "other");
		git(repo, "rm", "--quiet", "-rf", ".");
		writeFileSync(join(repo, "b.txt"), "b");
		git(repo, "add", "-A");
		git(repo, "commit", "--quiet", "-m", "root two");
		return {repo, a, b: git(repo, "rev-parse", "HEAD")};
	};

	it("exits non-zero with no merge base, while both revisions still resolve", () => {
		const {repo, a, b} = openUnrelatedPair();
		expect(() => git(repo, "merge-base", a, b)).toThrow();
		expect(git(repo, "rev-parse", "--verify", "--quiet", `${a}^{commit}`)).toBe(a);
		expect(git(repo, "rev-parse", "--verify", "--quiet", `${b}^{commit}`)).toBe(b);
	});

	it("exits non-zero the same way when a revision cannot be read, and that one does NOT resolve", () => {
		const {repo, a} = openUnrelatedPair();
		const absent = "refs/heads/never-cut";
		expect(() => git(repo, "merge-base", a, absent)).toThrow();
		expect(() => git(repo, "rev-parse", "--verify", "--quiet", `${absent}^{commit}`)).toThrow();
	});
});
