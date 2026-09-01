/**
 * A throwaway `origin` + clone on disk, for the two real-git tests that judge what git does when
 * several spawns work one clone at once (#6081, #7331).
 *
 * Not a test itself and not under `__fixtures__/`, which holds captured payloads rather than code.
 * It lives here because both concurrency files need the identical clone: a fixture that differs
 * between them would let one file's green rest on a repo shape the other never exercises.
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

/** Pinned away from the developer's own config: a fixture that inherits it proves what this machine does. */
export const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

export const gitSync = (cwd: string | undefined, ...args: ReadonlyArray<string>): string =>
	execFileSync("git", [...args], {cwd, env: GIT_ENV, encoding: "utf8"});

/** The git this machine runs, so a declared skip names the version it was declared against. */
export const gitVersion = (): string => gitSync(undefined, "--version").trim();

/**
 * Enough history that a fetch takes long enough for sibling fetches to genuinely overlap. With a
 * near-empty repo the fetches finish before each other start and the races never open at all.
 */
const COMMITS = 40;

export interface Clone {
	/** The clone every spawn in a test works against — one `.git` dir, many concurrent commands. */
	readonly clone: string;
	/** A scratch dir outside the clone, for worktrees a test adds. */
	readonly scratch: string;
	readonly tip: string;
}

const roots: string[] = [];

/** Every clone this process opened, removed together — call from one `afterAll`. */
export const removeClones = (): void => {
	for (const root of roots) rmSync(root, {recursive: true, force: true});
	roots.length = 0;
};

export const openClone = (): Clone => {
	const root = mkdtempSync(join(tmpdir(), "fabrika-worktree-"));
	roots.push(root);

	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	const clone = join(root, "clone");
	gitSync(undefined, "init", "--quiet", "--bare", "-b", "main", remote);
	gitSync(undefined, "init", "--quiet", "-b", "main", seed);
	for (let i = 0; i < COMMITS; i++) {
		writeFileSync(join(seed, `f${i}.txt`), `${"x".repeat(20_000)}${i}`);
		gitSync(seed, "add", "-A");
		gitSync(seed, "commit", "--quiet", "-m", `c${i}`);
	}
	gitSync(seed, "remote", "add", "origin", remote);
	gitSync(seed, "push", "--quiet", "origin", "main");
	// `--no-local`: a local clone hardlinks its objects and skips the transfer the race lives in.
	gitSync(undefined, "clone", "--quiet", "--no-local", remote, clone);

	return {clone, scratch: join(root, "trees"), tip: gitSync(seed, "rev-parse", "HEAD").trim()};
};
