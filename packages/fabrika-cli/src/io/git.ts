/**
 * The `git` half of the base-ref read: fetch first, then read what was fetched.
 *
 * **`--base` is fetched before it is read.** Reading a stale local ref is the defect class this
 * whole contract exists to close — a checkout sitting at `0150` while origin is at `0151` mints a
 * duplicate id (#3779), and a stale tree once made a review gate declare a merged ADR nonexistent
 * (#4163). Every read below takes the resolved base SHA, never a ref name, so nothing can silently
 * re-resolve to a different commit mid-run.
 */
import type {Exec} from "./exec.ts";

export type Failure = {readonly _tag: "Failure"; readonly reason: string};
export type Ok<A> = {readonly _tag: "Ok"; readonly value: A};
export type Attempt<A> = Ok<A> | Failure;

export const ok = <A>(value: A): Ok<A> => ({_tag: "Ok", value});
export const fail = (reason: string): Failure => ({_tag: "Failure", reason});

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
	remotes: ReadonlyArray<string>,
): {readonly remote: string; readonly ref: string} | null => {
	const slash = base.indexOf("/");
	if (slash <= 0) return null;
	const remote = base.slice(0, slash);
	const ref = base.slice(slash + 1);
	return remotes.includes(remote) && ref !== "" ? {remote, ref} : null;
};

/** `owner/name` from a remote URL, in either the SSH or HTTPS spelling. */
export const parseOwnerRepo = (url: string): string | null => {
	const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?\s*$/.exec(url.trim());
	return m?.[1] === undefined || m[2] === undefined ? null : `${m[1]}/${m[2]}`;
};

/** The configured remote names. */
export const remotes = (exec: Exec): ReadonlyArray<string> => {
	const r = exec("git", ["remote"]);
	return r.ok
		? r.stdout
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l !== "")
		: [];
};

/** The default `--repo`: `owner/name` off the `origin` remote's URL. */
export const originRepo = (exec: Exec): Attempt<string> => {
	const r = exec("git", ["remote", "get-url", "origin"]);
	if (!r.ok) return fail(r.reason);
	const parsed = parseOwnerRepo(r.stdout);
	return parsed === null
		? fail(`cannot parse owner/name from origin URL "${r.stdout.trim()}"`)
		: ok(parsed);
};

/**
 * Fetch `base` and resolve it to a commit SHA.
 *
 * The fetch is not best-effort: if it fails the merged set is UNKNOWN and the caller refuses. A
 * resolution that comes back in a shape that is not an object name is treated the same way — an
 * unreadable input resolves to a refusal, never to a permissive default.
 */
export const fetchAndResolve = (exec: Exec, base: string): Attempt<string> => {
	const split = splitRemoteRef(base, remotes(exec));
	const fetched =
		split === null
			? exec("git", ["fetch", "--quiet"])
			: exec("git", ["fetch", "--quiet", split.remote, split.ref]);
	if (!fetched.ok) return fail(fetched.reason);
	const resolved = exec("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
	if (!resolved.ok) return fail(`cannot resolve ${base} to a commit after fetching`);
	const sha = resolved.stdout.trim();
	return isObjectName(sha)
		? ok(sha)
		: fail(`git resolved ${base} to "${sha}", which is not an object name`);
};

/**
 * The base names of every file under `dir` at `sha` (one level; the record directory is flat).
 *
 * Newline-separated rather than `-z`: a record base name is `NNNN-slug.md` by construction, so
 * there is no name a newline could split, and a plain line grammar keeps the fixtures readable.
 */
export const listDir = (exec: Exec, sha: string, dir: string): Attempt<ReadonlyArray<string>> => {
	const r = exec("git", ["ls-tree", "--name-only", `${sha}:${dir}`]);
	if (!r.ok) return fail(r.reason);
	return ok(
		r.stdout
			.split("\n")
			.map((n) => n.trim())
			.filter((n) => n !== ""),
	);
};

/** One file's contents at `sha`. */
export const readFileAt = (exec: Exec, sha: string, path: string): Attempt<string> => {
	const r = exec("git", ["show", `${sha}:${path}`]);
	return r.ok ? ok(r.stdout) : fail(r.reason);
};
