/**
 * The `git` half of the base-ref read: fetch first, then read what was fetched.
 *
 * **`--base` is fetched before it is read.** Reading a stale local ref is the defect class this
 * whole contract exists to close — a checkout sitting at `0150` while origin is at `0151` mints a
 * duplicate id (#3779), and a stale tree once made a review gate declare a merged ADR nonexistent
 * (#4163). Every read below takes the resolved base SHA, never a ref name, so nothing can silently
 * re-resolve to a different commit mid-run.
 *
 * The outcome type is {@link Attempt} rather than the `E` channel on purpose: a fetch that fails and
 * a `ls-tree` that fails are *expected outcomes* this package maps onto its own exit codes, and each
 * carries the reason it quotes in the refusal. The subprocess fault underneath is already typed —
 * `execCapture` folds it into `ok: false` (see `exec.ts`).
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execCapture} from "./exec.ts";

export type Failure = {readonly _tag: "Failure"; readonly reason: string};
export type Ok<A> = {readonly _tag: "Ok"; readonly value: A};
export type Attempt<A> = Ok<A> | Failure;

export const ok = <A>(value: A): Ok<A> => ({_tag: "Ok", value});
export const fail = (reason: string): Failure => ({_tag: "Failure", reason});

/** Anything in this module: it shells out, so the platform spawner is its one requirement. */
export type Shell<A> = Effect.Effect<A, never, ChildProcessSpawner.ChildProcessSpawner>;

/** A 40- or 64-hex object name. Validating the SHAPE is what stops a stray line reading as a SHA. */
export const isObjectName = (s: string): boolean => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s.trim());

/**
 * Split a base ref into the remote to fetch and the ref to fetch from it.
 *
 * `origin/main` fetches `main` from `origin`, so a wrong ref surfaces as git's own
 * `couldn't find remote ref` rather than as a silent read of a stale local branch. A ref naming no
 * configured remote (`main`, `HEAD`, a raw SHA) has no remote half; the caller then fetches the
 * default remote wholesale so the read is still against fetched state.
 */
export const splitRemoteRef = (
	base: string,
	remoteNames: ReadonlyArray<string>,
): {readonly remote: string; readonly ref: string} | null => {
	const slash = base.indexOf("/");
	if (slash <= 0) return null;
	const remote = base.slice(0, slash);
	const ref = base.slice(slash + 1);
	return remoteNames.includes(remote) && ref !== "" ? {remote, ref} : null;
};

/** `owner/name` from a remote URL, in either the SSH or HTTPS spelling. */
export const parseOwnerRepo = (url: string): string | null => {
	const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?\s*$/.exec(url.trim());
	return m?.[1] === undefined || m[2] === undefined ? null : `${m[1]}/${m[2]}`;
};

/** The configured remote names. */
export const remotes: Shell<ReadonlyArray<string>> = Effect.gen(function* () {
	const r = yield* execCapture("git", ["remote"]);
	return r.ok
		? r.stdout
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l !== "")
		: [];
});

/**
 * The first remote in `git remote -v` output whose URL names `repo`, or `null`.
 *
 * Matched on the parsed `owner/name` rather than on the URL text so the SSH and HTTPS spellings of
 * one repository are one answer, and case-insensitively because GitHub's own names are.
 */
export const matchRemote = (remoteV: string, repo: string): string | null => {
	const want = repo.trim().toLowerCase();
	for (const line of remoteV.split("\n")) {
		const [name, rest] = line.split("\t");
		if (name === undefined || rest === undefined) continue;
		const url = rest.replace(/\s*\((fetch|push)\)\s*$/, "");
		if (parseOwnerRepo(url)?.toLowerCase() === want) return name.trim();
	}
	return null;
};

/** The configured remote serving `repo`, or `null` when this checkout serves some other repository. */
export const remoteFor = (repo: string): Shell<string | null> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["remote", "-v"]);
		return r.ok ? matchRemote(r.stdout, repo) : null;
	});

/** Fetch one ref from a remote into the object database. No ref is checked out. */
export const fetchRef = (remote: string, ref: string): Shell<Attempt<void>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["fetch", "--quiet", remote, ref]);
		return r.ok ? ok<void>(undefined) : fail(r.reason);
	});

/**
 * Resolve `rev` to the full object name of a commit, from the object database.
 *
 * `^{commit}` is what makes the answer a commit rather than whatever object the name happens to
 * reach, and `--verify` is what makes an unresolvable name an error instead of an echo.
 */
export const resolveCommit = (rev: string, qualifier = ""): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
		if (!r.ok) return fail(`cannot resolve ${rev} to a commit${qualifier}`);
		const sha = r.stdout.trim();
		return isObjectName(sha)
			? ok(sha)
			: fail(`git resolved ${rev} to "${sha}", which is not an object name`);
	});

/**
 * The flags every diff read below is taken under, so the bytes depend on the two commits and not on
 * the invoking user's `~/.gitconfig`.
 *
 * `--no-ext-diff` refuses a configured external differ, and the explicit prefixes defeat
 * `diff.noprefix` / `diff.mnemonicPrefix` — under either, the `diff --git a/… b/…` header the
 * completeness proof and the Tier-M walk parse (`../review/diff.ts`) simply stops appearing.
 */
const DIFF_FLAGS = [
	"--no-ext-diff",
	"--no-color",
	"--find-renames",
	"--src-prefix=a/",
	"--dst-prefix=b/",
];

/**
 * The unified diff between the merge base of `base` and `head`, and `head` — read from the object
 * database, with nothing checked out.
 *
 * Three dots, because that is the range a pull request *is*: what the head adds since it diverged,
 * never the base branch's own later commits.
 */
export const diffRange = (base: string, head: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["diff", ...DIFF_FLAGS, `${base}...${head}`]);
		return r.ok ? ok(r.stdout) : fail(r.reason);
	});

/** The paths that diff changes, NUL-separated so a path no name grammar survives still arrives whole. */
export const diffRangePaths = (base: string, head: string): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [
			"diff",
			...DIFF_FLAGS,
			"--name-only",
			"-z",
			`${base}...${head}`,
		]);
		return r.ok ? ok(r.stdout.split("\0").filter((p) => p !== "")) : fail(r.reason);
	});

/** The default `--repo`: `owner/name` off the `origin` remote's URL. */
export const originRepo: Shell<Attempt<string>> = Effect.gen(function* () {
	const r = yield* execCapture("git", ["remote", "get-url", "origin"]);
	if (!r.ok) return fail(r.reason);
	const parsed = parseOwnerRepo(r.stdout);
	return parsed === null
		? fail(`cannot parse owner/name from origin URL "${r.stdout.trim()}"`)
		: ok(parsed);
});

/**
 * Fetch `base` and resolve it to a commit SHA.
 *
 * The fetch is not best-effort: if it fails the merged set is UNKNOWN and the caller refuses. A
 * resolution that comes back in a shape that is not an object name is treated the same way — an
 * unreadable input resolves to a refusal, never to a permissive default.
 */
export const fetchAndResolve = (base: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const split = splitRemoteRef(base, yield* remotes);
		if (split === null) {
			const all = yield* execCapture("git", ["fetch", "--quiet"]);
			if (!all.ok) return fail(all.reason);
		} else {
			const fetched = yield* fetchRef(split.remote, split.ref);
			if (fetched._tag === "Failure") return fetched;
		}
		return yield* resolveCommit(base, " after fetching");
	});

/**
 * The base names of every file under `dir` at `sha` (one level; the record directory is flat).
 *
 * Newline-separated rather than `-z`: a record base name is `NNNN-slug.md` by construction, so
 * there is no name a newline could split, and a plain line grammar keeps the fixtures readable.
 */
export const listDir = (sha: string, dir: string): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["ls-tree", "--name-only", `${sha}:${dir}`]);
		if (!r.ok) return fail(r.reason);
		return ok(
			r.stdout
				.split("\n")
				.map((n) => n.trim())
				.filter((n) => n !== ""),
		);
	});

/** One file's contents at `sha`. */
export const readFileAt = (sha: string, path: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["show", `${sha}:${path}`]);
		return r.ok ? ok(r.stdout) : fail(r.reason);
	});
