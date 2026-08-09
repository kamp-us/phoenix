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
import {execCapture} from "../io/exec.ts";
import {
	type Attempt,
	fail,
	isObjectName,
	ok,
	remotes,
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

/** The merge base of HEAD and `base` — where this lane's diff starts. */
export const mergeBase = (base: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["merge-base", "HEAD", base]);
		if (!r.ok) return fail(r.reason);
		const sha = r.stdout.trim();
		return isObjectName(sha) ? ok(sha) : fail(`git named no merge base with ${base}`);
	});

/** Every path this tree changes against `base`, committed and working-tree alike. */
export const changedFiles = (base: string): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["diff", "--name-only", base]);
		if (!r.ok) return fail(r.reason);
		return ok(
			r.stdout
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l !== ""),
		);
	});
