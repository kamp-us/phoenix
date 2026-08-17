/**
 * The range digest's durability, driven against **real git** in a throwaway repository (#5825).
 *
 * The claim under test is not one about hashing — it is one about what git leaves behind when a
 * child's range is merged into an epic branch. "A clean merge preserves the destination blobs" and
 * "a conflict resolution moves them" are statements about a program's behaviour, so they are run
 * rather than reasoned about (CLAUDE.md: ground platform claims in source or in a real run).
 *
 * What is exercised here is the derivation the shipped code performs: the argv from
 * {@link rawDiffArgs}, the walk in {@link parseRaw}, the serialization in {@link contentDigest} and
 * the pathspec from {@link judgedPaths}. The Effect wrappers around them (`rangeContentAt`,
 * `rangeDigestOnto`) fold the same pieces over a scripted shell in `content-binding.unit.test.ts` —
 * that split is deliberate: `execCapture` runs in the process's own working directory, so pointing
 * it at a fixture repository would mean mutating the test runner's cwd.
 */
import {execFileSync} from "node:child_process";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {type CommitRange, rawDiffArgs} from "../io/git.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {contentDigest, judgedPaths, parseRaw} from "./content-binding.ts";

/**
 * Both config layers are pinned away from the developer's own: merge behaviour is configurable
 * (`merge.conflictstyle`, `merge.ff`, `diff.renames`), and a fixture that inherits it proves what
 * this machine does rather than what git does.
 */
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
	GIT_AUTHOR_DATE: "2026-08-15T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-08-15T00:00:00Z",
};

interface Repo {
	readonly git: (...args: ReadonlyArray<string>) => string;
	readonly write: (path: string, body: string) => void;
	readonly commit: (message: string) => string;
	readonly rev: (ref: string) => string;
}

const openRepo = (): Repo => {
	const dir = mkdtempSync(join(tmpdir(), "fabrika-range-"));
	const git = (...args: ReadonlyArray<string>): string =>
		execFileSync("git", [...args], {cwd: dir, env: GIT_ENV, encoding: "utf8"});
	git("init", "--quiet", "-b", "epic");
	const rev = (ref: string): string => git("rev-parse", ref).trim();
	return {
		git,
		rev,
		write: (path, body) => writeFileSync(join(dir, path), body),
		commit: (message) => {
			git("add", "-A");
			git("commit", "--quiet", "-m", message);
			return rev("HEAD");
		},
	};
};

/** The digest of a range, taken over the same argv and the same serialization production uses. */
const digestOf = (repo: Repo, range: CommitRange, paths: ReadonlyArray<string> = []): string => {
	const parsed = parseRaw(repo.git(...rawDiffArgs(range, paths)));
	if (typeof parsed === "string") throw new Error(`unreadable --raw stream: ${parsed}`);
	return contentDigest(parsed);
};

const pathsOf = (repo: Repo, range: CommitRange): ReadonlyArray<string> => {
	const parsed = parseRaw(repo.git(...rawDiffArgs(range)));
	if (typeof parsed === "string") throw new Error(`unreadable --raw stream: ${parsed}`);
	return judgedPaths(parsed);
};

/**
 * One epic branch, one child branch off it, and the verdict a reviewer would have formed on the
 * child: the digest of `base...tip` and the paths that digest was taken over.
 */
const withChild = () => {
	const repo = openRepo();
	repo.write("cart.ts", "one\n");
	repo.write("untouched.ts", "steady\n");
	const base = repo.commit("base");

	repo.git("checkout", "--quiet", "-b", "child");
	repo.write("cart.ts", "one\ntwo\n");
	repo.write("added.ts", "new\n");
	const tip = repo.commit("child work");
	repo.git("checkout", "--quiet", "epic");

	const range: CommitRange = {base, tip};
	return {repo, range, judged: pathsOf(repo, range), verdict: digestOf(repo, range)};
};

/** The verdict's own re-derivation: `<base>...<state>` limited to the paths the verdict judged. */
const rederive = (
	repo: Repo,
	range: CommitRange,
	judged: ReadonlyArray<string>,
	state: string,
): string => digestOf(repo, {base: range.base, tip: state}, judged);

describe("a range verdict's digest across the merge into its epic branch", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it("holds across a fast-forward — the epic branch becomes the range, byte for byte", () => {
		const {repo, range, judged, verdict} = withChild();
		repo.git("merge", "--quiet", "--ff-only", "child");
		expect(rederive(repo, range, judged, repo.rev("epic"))).toBe(verdict);
	});

	it("holds across a clean merge that preserves every judged blob", () => {
		const {repo, range, judged, verdict} = withChild();
		repo.write("sibling.ts", "another child's work\n");
		repo.commit("a sibling lands first");
		repo.git("merge", "--quiet", "--no-ff", "-m", "merge child", "child");

		// The merge commit's tree carries the sibling's path too; the pathspec is what keeps this
		// verdict's answer about its own content rather than about the whole branch.
		expect(rederive(repo, range, judged, repo.rev("epic"))).toBe(verdict);
		expect(digestOf(repo, {base: range.base, tip: repo.rev("epic")})).not.toBe(verdict);
	});

	it("MOVES across a conflicted merge whose resolution rewrites a judged path", () => {
		const {repo, range, judged, verdict} = withChild();
		repo.write("cart.ts", "one\nconflicting\n");
		repo.commit("the epic branch edits the same file");
		expect(() => repo.git("merge", "--quiet", "--no-ff", "-m", "merge child", "child")).toThrow();

		repo.write("cart.ts", "one\ntwo\nconflicting\n");
		repo.git("add", "-A");
		repo.git("commit", "--quiet", "--no-edit");
		expect(rederive(repo, range, judged, repo.rev("epic"))).not.toBe(verdict);
	});

	it("MOVES on a later commit touching a judged path, after the merge held", () => {
		const {repo, range, judged, verdict} = withChild();
		repo.git("merge", "--quiet", "--ff-only", "child");
		expect(rederive(repo, range, judged, repo.rev("epic"))).toBe(verdict);

		repo.write("cart.ts", "one\ntwo\nthree\n");
		repo.commit("someone edits the reviewed file afterwards");
		expect(rederive(repo, range, judged, repo.rev("epic"))).not.toBe(verdict);
	});

	it("holds when a later commit touches a path the verdict never judged", () => {
		const {repo, range, judged, verdict} = withChild();
		repo.git("merge", "--quiet", "--ff-only", "child");
		repo.write("untouched.ts", "moved on\n");
		repo.commit("an unjudged path changes");
		expect(rederive(repo, range, judged, repo.rev("epic"))).toBe(verdict);
	});

	it("carries a rename's SOURCE path, so the rename is still detectable under the pathspec", () => {
		const repo = openRepo();
		repo.write("old.ts", "content\n");
		const base = repo.commit("base");
		repo.git("checkout", "--quiet", "-b", "child");
		repo.git("mv", "old.ts", "new.ts");
		const tip = repo.commit("rename");
		repo.git("checkout", "--quiet", "epic");

		const range: CommitRange = {base, tip};
		const judged = pathsOf(repo, range);
		expect(judged).toEqual(["new.ts", "old.ts"]);

		repo.git("merge", "--quiet", "--ff-only", "child");
		expect(rederive(repo, range, judged, repo.rev("epic"))).toBe(digestOf(repo, range));
	});
});
