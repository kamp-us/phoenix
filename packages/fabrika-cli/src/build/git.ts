/**
 * The git operations the lane verbs perform: fetch, cut, switch, diff, push, and the independent
 * read-back of a remote ref.
 *
 * Two disciplines, both scars:
 *
 * - **A branch is cut off `FETCH_HEAD`, never off a local remote-tracking ref.** A checkout's
 *   `origin/main` can predate the commit the lane needs, and a branch cut off it misses work that is
 *   already on the base (#1920 / #3621). Every create here fetches first and cuts off what was just
 *   fetched.
 * - **A push is believed only after the remote ref is read back.** `git push`'s own report is not
 *   evidence: a push that died mid-hook read as sent (#4136). {@link remoteSha} asks the remote
 *   directly, and the caller compares.
 */
import {Effect} from "effect";
import {execCapture, execCaptureInput} from "../io/exec.ts";
import {
	type Attempt,
	fail,
	fetchRef,
	isObjectName,
	ok,
	remotes,
	resolveCommit,
	type Shell,
	splitRemoteRef,
} from "../io/git.ts";

/** The tree's HEAD commit. */
export const headSha: Shell<Attempt<string>> = Effect.gen(function* () {
	const r = yield* execCapture("git", ["rev-parse", "HEAD"]);
	if (!r.ok) return fail(r.reason);
	const sha = r.stdout.trim();
	return isObjectName(sha) ? ok(sha) : fail(`git resolved HEAD to "${sha}", not an object name`);
});

/** Fetch `base` (e.g. `origin/main`) and resolve what was fetched, so a cut never uses a stale ref. */
export const fetchBase = (base: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const split = splitRemoteRef(base, yield* remotes);
		const fetched = yield* split === null
			? execCapture("git", ["fetch", "--quiet"])
			: execCapture("git", ["fetch", "--quiet", split.remote, split.ref]);
		if (!fetched.ok) return fail(fetched.reason);
		const resolved = yield* execCapture("git", [
			"rev-parse",
			"--verify",
			"--quiet",
			split === null ? `${base}^{commit}` : "FETCH_HEAD^{commit}",
		]);
		if (!resolved.ok) return fail(`cannot resolve ${base} to a commit after fetching`);
		const sha = resolved.stdout.trim();
		return isObjectName(sha)
			? ok(sha)
			: fail(`git resolved ${base} to "${sha}", not an object name`);
	});

export const branchExists = (name: string): Shell<boolean> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
		return r.ok;
	});

/** Check out an existing local branch. */
export const switchTo = (name: string): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["switch", name]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** Cut `name` at `start` and check it out. */
export const switchToNew = (name: string, start: string): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["switch", "-c", name, start]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/**
 * Re-key an existing local branch to a new name — how a repair lane takes over an epic child's branch.
 *
 * Renaming rather than cutting a second branch off the first is the whole point: two branches
 * carrying one child's commits is what `lane prove` reports as an underivable range, and that
 * refusal is unresolvable from inside a worktree (#6386).
 *
 * **It does not refuse a branch another worktree has checked out**, which is the trap the caller
 * guards with {@link worktreeCheckouts}: `git branch -m` exits 0 there and silently retargets that
 * worktree's `HEAD` to the new name — only the `git switch` afterwards fails, by which point the
 * rename has already landed under a lane that is not this one. Measured against git 2.40.1 rather
 * than reasoned about (#6386, review round 1).
 */
export const renameBranch = (from: string, to: string): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["branch", "-m", from, to]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** One worktree of this repo, and the branch it holds checked out. */
export interface WorktreeCheckout {
	readonly path: string;
	readonly branch: string;
}

/**
 * Every worktree of this repo that holds a branch, paired with the branch it holds.
 *
 * The proof {@link renameBranch} needs and cannot make for itself. A detached worktree contributes
 * no row: it holds no branch name, so it can collide with none.
 */
export const worktreeCheckouts: Shell<Attempt<ReadonlyArray<WorktreeCheckout>>> = Effect.gen(
	function* () {
		const r = yield* execCapture("git", ["worktree", "list", "--porcelain"]);
		if (!r.ok) return fail(r.reason);
		const held: Array<WorktreeCheckout> = [];
		let path = "";
		for (const line of r.stdout.split("\n")) {
			if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
			else if (line.startsWith("branch refs/heads/") && path !== "") {
				held.push({path, branch: line.slice("branch refs/heads/".length).trim()});
			}
		}
		return ok(held);
	},
);

/** The branch this tree holds, or `null` when its HEAD is detached. */
export const currentBranch: Shell<Attempt<string | null>> = Effect.gen(function* () {
	const r = yield* execCapture("git", ["branch", "--show-current"]);
	if (!r.ok) return fail(r.reason);
	const name = r.stdout.trim();
	return ok(name === "" ? null : name);
});

/** Point a local branch's upstream at `<remote>/<ref>` — how resume mode publishes to the PR's head. */
export const setUpstream = (name: string, remote: string, ref: string): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["branch", `--set-upstream-to=${remote}/${ref}`, name]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** `<remote>\t<ref>` of the checked-out branch's upstream, or `null` when it tracks nothing. */
export const upstreamOf = (branch: string): Shell<{remote: string; ref: string} | null> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			`${branch}@{upstream}`,
		]);
		if (!r.ok) return null;
		const split = splitRemoteRef(r.stdout.trim(), yield* remotes);
		return split === null ? null : {remote: split.remote, ref: split.ref};
	});

/** The SHA a remote's ref points at, read from the remote itself — the push's independent witness. */
export const remoteSha = (remote: string, ref: string): Shell<Attempt<string | null>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["ls-remote", remote, `refs/heads/${ref}`]);
		if (!r.ok) return fail(r.reason);
		const first = r.stdout.split("\n").find((line) => line.trim() !== "");
		if (first === undefined) return ok(null);
		const sha = (first.split(/\s+/)[0] ?? "").trim();
		return isObjectName(sha)
			? ok(sha)
			: fail(`\`git ls-remote\` printed "${first}", not a ref row`);
	});

/**
 * Make `sha` readable from this object database, fetching `<remote>/<ref>` once if it is not, and
 * answer whether it now is.
 *
 * {@link isAncestor} needs both commits present locally, and a repair lane's published head can be a
 * commit this clone has never held. A missing object is UNKNOWN — never "not an ancestor" — so this
 * answers presence and leaves the conclusion to the caller.
 */
export const ensureCommitPresent = (remote: string, ref: string, sha: string): Shell<boolean> =>
	Effect.gen(function* () {
		const present = (yield* resolveCommit(sha))._tag === "Ok";
		if (present) return true;
		yield* fetchRef(remote, ref);
		return (yield* resolveCommit(sha))._tag === "Ok";
	});

/** How many dropped commits a refusal names before it truncates. */
const DROPPED_SHOWN = 10;

/**
 * The commits reachable from `remoteHead` and not from `local` — exactly what a force push drops.
 *
 * Reported as text for a human to read in the refusal, so a failure to enumerate degrades to an empty
 * list rather than to a second failure mode: the containment verdict is already proven by then.
 */
export const commitsDropped = (
	local: string,
	remoteHead: string,
): Shell<{readonly lines: ReadonlyArray<string>; readonly truncated: boolean}> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [
			"log",
			"--no-decorate",
			"--format=%h %s",
			`-n`,
			`${DROPPED_SHOWN + 1}`,
			`${local}..${remoteHead}`,
		]);
		if (!r.ok) return {lines: [], truncated: false};
		const lines = r.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l !== "");
		return {lines: lines.slice(0, DROPPED_SHOWN), truncated: lines.length > DROPPED_SHOWN};
	});

/** Whether `ancestor` is reachable from `descendant` — the fast-forward test. */
export const isAncestor = (ancestor: string, descendant: string): Shell<boolean> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["merge-base", "--is-ancestor", ancestor, descendant]);
		return r.ok;
	});

export const push = (remote: string, ref: string, force: boolean): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [
			"push",
			...(force ? ["--force-with-lease"] : []),
			remote,
			`HEAD:refs/heads/${ref}`,
		]);
		return r.ok ? ok(undefined) : fail(r.reason);
	});

/** The paths staged for commit. An empty list is a proven "there is nothing to commit". */
export const stagedPaths: Shell<Attempt<ReadonlyArray<string>>> = Effect.gen(function* () {
	const r = yield* execCapture("git", ["diff", "--cached", "--name-only", "-z"]);
	return r.ok ? ok(r.stdout.split("\0").filter((p) => p !== "")) : fail(r.reason);
});

/**
 * `--cleanup=verbatim` — git records the message byte for byte.
 *
 * Every other mode edits it (`whitespace` collapses consecutive blank lines, `strip` deletes `#`
 * lines), and an edited message makes the read-back below compare two things that were never meant
 * to be equal — a false mismatch on a clean run, which is the fastest way to get a real one ignored.
 */
const COMMIT_FLAGS = ["commit", "--cleanup=verbatim"];

/** Create a commit from a message on git's own stdin — the file-free carrying path (#5484). */
export const commitFromStdin = (message: string): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCaptureInput("git", [...COMMIT_FLAGS, "-F", "-"], message);
		return r.ok ? ok<void>(undefined) : fail(r.reason);
	});

/** Create a commit from a message file. The caller proves the path is this lane's allocator's. */
export const commitFromFile = (path: string): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [...COMMIT_FLAGS, "-F", path]);
		return r.ok ? ok<void>(undefined) : fail(r.reason);
	});

/**
 * The message git actually recorded on a commit — the independent witness `build commit` turns on.
 *
 * `%B` is the raw body, so what comes back is what a reviewer will read in the merge record. The
 * whole point of asking git rather than trusting the invocation is #5484: the message reaching the
 * commit and the message the lane authored were different, every command exited 0, and nothing but
 * a read-back could tell.
 */
export const commitMessage = (sha: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["log", "-1", "--format=%B", sha]);
		return r.ok ? ok(r.stdout) : fail(r.reason);
	});

/** The merge base of HEAD and `base` — where this lane's diff starts. */
export const mergeBase = (base: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["merge-base", "HEAD", base]);
		if (!r.ok) return fail(r.reason);
		const sha = r.stdout.trim();
		return isObjectName(sha) ? ok(sha) : fail(`git named no merge base with ${base}`);
	});

/**
 * Which of `paths` the commit `rev` actually holds — the roster that tells a file this diff *created*
 * from one whose read failed.
 *
 * Without it, `git show rev:path` answers both with a non-zero exit, and a caller reading that as
 * "the file is new" turns an IO fault into an empty baseline, which reds a clean PR; reading it as a
 * fault refuses every PR that adds a doc. Asking the tree first keeps the two apart.
 *
 * `-z` because a path with a space or a quote is quoted in the default output and would come back in
 * a spelling that matches nothing. `--literal-pathspecs` because these operands are pathspecs: a path
 * carrying `*`, `?`, `[` or a leading `:` would otherwise match something other than itself, and the
 * roster would answer about a file nobody asked for.
 *
 * `-C root` is why the caller passes a root at all: an `ls-tree` pathspec resolves against the
 * process cwd, and `--literal-pathspecs` also switches off the `:(top)` magic that would anchor it,
 * so from a subdirectory every root-relative path matches nothing. That failure is exit 0 with no
 * output — indistinguishable from "this diff created all of them", the one distinction this reader
 * exists to keep. Pinning the cwd makes the operands and the printed names root-relative both.
 */
export const treePaths = (
	root: string,
	rev: string,
	paths: ReadonlyArray<string>,
): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		if (paths.length === 0) return ok([]);
		const r = yield* execCapture("git", [
			"-C",
			root,
			"--literal-pathspecs",
			"ls-tree",
			"-r",
			"--name-only",
			"-z",
			rev,
			"--",
			...paths,
		]);
		if (!r.ok) return fail(r.reason);
		return ok(r.stdout.split("\0").filter((p) => p !== ""));
	});

/**
 * A file's bytes as of `rev`. The caller proves the path is in that rev's tree first.
 *
 * `-C root` for the same reason as `treePaths`: a `<rev>:<path>` operand happens to resolve from the
 * tree root today, and pinning the cwd makes the pair anchored by design rather than by accident.
 */
export const showAt = (root: string, rev: string, path: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["-C", root, "show", `${rev}:${path}`]);
		return r.ok ? ok(r.stdout) : fail(r.reason);
	});

const pathLines = (stdout: string): ReadonlyArray<string> =>
	stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");

/**
 * Every path this tree changes against `base`: what `git diff` reports — commits plus tracked
 * working-tree edits — unioned with the untracked, non-ignored paths `git ls-files --others` lists.
 * Deduped and sorted, so a path listed by both sources appears once.
 *
 * Ignored files stay out; `--exclude-standard` is what keeps them out.
 *
 * `--full-name -- :/` is load-bearing on the second read: bare `ls-files --others` is cwd-scoped and
 * prints cwd-relative paths, while `git diff` is repo-wide and root-relative. Run from a
 * subdirectory the two disagree, dropping untracked files outside the cwd and handing the rest a
 * path that does not resolve against `lane.root`. The pathspec restores repo-wide, the flag
 * restores root-relative.
 *
 * The second source is the scar (#5823). `git diff` never reports an untracked path, so a
 * brand-new file was absent from the list `build check` partitions — neither validated nor named in
 * `unvalidated`, invisible instead of disclosed, while the verdict read green. The natural lane
 * order is construct, check, then commit, which is exactly the window where a new file is untracked.
 *
 * Either source failing is a failure of the whole read: a short list here becomes a green that
 * understates its own coverage, which is the fail-open direction.
 */
export const changedFiles = (base: string): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const tracked = yield* execCapture("git", ["diff", "--name-only", base]);
		if (!tracked.ok) return fail(tracked.reason);
		const untracked = yield* execCapture("git", [
			"ls-files",
			"--others",
			"--exclude-standard",
			"--full-name",
			"--",
			":/",
		]);
		if (!untracked.ok) return fail(untracked.reason);
		const union = new Set([...pathLines(tracked.stdout), ...pathLines(untracked.stdout)]);
		return ok([...union].sort());
	});
