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
 * the invoking user's own git configuration.
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

/**
 * A commit range as this package names one: what `tip` adds since it diverged from `base`.
 *
 * `Rev` is a parameter so a caller holding validated revisions — a verdict marker's branded SHAs —
 * carries that validation into the range instead of widening back to `string` at the boundary.
 */
export interface CommitRange<Rev extends string = string> {
	readonly base: Rev;
	readonly tip: Rev;
}

/**
 * The argv of the `--raw` read, written once because a digest is only comparable across two runs of
 * the *same* invocation. A test that re-types these flags proves a serialization production never
 * computes, which is why this is exported rather than inlined below.
 *
 * `--abbrev=40` because the default abbreviation is a display convenience whose width depends on
 * the repository's object count — a digest taken over abbreviated names would change with the clone
 * rather than with the content (`../review/content-binding.ts`).
 *
 * An empty `paths` reads the whole range; a non-empty one limits it to that pathspec. A caller that
 * means "these paths and no others" must therefore refuse an empty set before it reaches here — a
 * pathspec that silently widens to everything digests a scope nobody chose (ADR 0092).
 */
export const rawDiffArgs = (
	range: CommitRange,
	paths: ReadonlyArray<string> = [],
): ReadonlyArray<string> => [
	"diff",
	...DIFF_FLAGS,
	"--raw",
	"--abbrev=40",
	"-z",
	`${range.base}...${range.tip}`,
	...(paths.length === 0 ? [] : ["--", ...paths]),
];

/** The `--raw` record stream of a range: one header per changed path naming both endpoint blobs. */
export const diffRangeRaw = (
	base: string,
	head: string,
	paths: ReadonlyArray<string> = [],
): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", rawDiffArgs({base, tip: head}, paths));
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

/**
 * The working tree's root, from the current directory.
 *
 * A directory that is not a repository fails rather than answering the current directory: a
 * containment test taken against a guessed root is a test about nothing.
 */
export const repoRoot: Shell<Attempt<string>> = Effect.gen(function* () {
	const r = yield* execCapture("git", ["rev-parse", "--show-toplevel"]);
	if (!r.ok) return fail(r.reason);
	const root = r.stdout.trim();
	return root === "" ? fail("`git rev-parse --show-toplevel` named no root") : ok(root);
});

/**
 * The working tree's whole status at `root`, ignored paths included.
 *
 * `--ignored=matching` is not the default invocation and is deliberate: a build cache, a
 * `node_modules/`, a `.env` all land on ignored paths, so a status blind to them would report a
 * tree as unchanged over exactly the writes a disposability check exists to find.
 */
export const treeStatus = (root: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [
			"-C",
			root,
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
			"--ignored=matching",
		]);
		return r.ok ? ok(r.stdout) : fail(r.reason);
	});

/** One file's contents at `sha`. */
export const readFileAt = (sha: string, path: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["show", `${sha}:${path}`]);
		return r.ok ? ok(r.stdout) : fail(r.reason);
	});

// ---------------------------------------------------------------------------------------------
// The `governance` group's reads, appended as one block so a later verb slice extends the file here
// rather than colliding with the range reads above (#5199).
// ---------------------------------------------------------------------------------------------

/** One changed path and the single letter git gives its change. */
export interface ChangedPath {
	/** `A`, `M`, `D`, `R<score>`, `C<score>`, `T` — git's own letter, never normalized here. */
	readonly status: string;
	/** For a rename or copy this is the **destination**, which is the path that now exists. */
	readonly path: string;
}

/**
 * Split a NUL-separated `--name-status` stream into rows.
 *
 * A rename or copy emits three fields (`R100`, source, destination) where every other change emits
 * two, so the walk is stateful rather than a chunk-of-two. Getting that wrong shifts every later row
 * by one field, which reads back as a well-formed change list naming the wrong paths.
 */
export const parseNameStatus = (stdout: string): ReadonlyArray<ChangedPath> => {
	const fields = stdout.split("\0").filter((f) => f !== "");
	const rows: ChangedPath[] = [];
	for (let i = 0; i < fields.length; ) {
		const status = fields[i] ?? "";
		const renamed = status.startsWith("R") || status.startsWith("C");
		const path = fields[i + (renamed ? 2 : 1)];
		if (path === undefined) break;
		rows.push({status, path});
		i += renamed ? 3 : 2;
	}
	return rows;
};

/** The changed paths of `base...head` with their change letters. */
export const diffRangeStatuses = (
	base: string,
	head: string,
): Shell<Attempt<ReadonlyArray<ChangedPath>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [
			"diff",
			...DIFF_FLAGS,
			"--name-status",
			"-z",
			`${base}...${head}`,
		]);
		return r.ok ? ok(parseNameStatus(r.stdout)) : fail(r.reason);
	});

/** Every tracked path at `sha`, recursively — how a fenced skill root is resolved without a checkout. */
export const listTreePaths = (sha: string): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["ls-tree", "-r", "--name-only", "-z", sha]);
		return r.ok ? ok(r.stdout.split("\0").filter((p) => p !== "")) : fail(r.reason);
	});

/** Every local branch this tree's refs carry, in git's own ordering. */
export const localBranches: Shell<Attempt<ReadonlyArray<string>>> = Effect.gen(function* () {
	const r = yield* execCapture("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
	return r.ok
		? ok(
				r.stdout
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== ""),
			)
		: fail(r.reason);
});

/** One commit a range adds: its object name and its whole message, subject and body together. */
export interface RangeCommit {
	readonly sha: string;
	readonly message: string;
}

const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

/**
 * The commits `tip` adds over `base`, newest first — two dots, because the question is what this
 * branch carries that the base does not.
 *
 * Framed with the two ASCII separators rather than newlines or NULs: a commit message is multi-line
 * by construction, so a line-oriented format splits one message into commits nobody wrote, and `-z`
 * frames records with the same NUL a pathological message may carry inside it.
 */
export const rangeCommits = (
	base: string,
	tip: string,
): Shell<Attempt<ReadonlyArray<RangeCommit>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [
			"log",
			`--format=%H${FIELD_SEPARATOR}%B${RECORD_SEPARATOR}`,
			`${base}..${tip}`,
		]);
		if (!r.ok) return fail(r.reason);
		const rows: RangeCommit[] = [];
		for (const record of r.stdout.split(RECORD_SEPARATOR)) {
			if (record.trim() === "") continue;
			const at = record.indexOf(FIELD_SEPARATOR);
			const sha = at < 0 ? "" : record.slice(0, at).trim();
			if (!isObjectName(sha)) return fail(`unreadable log record "${record.trim().slice(0, 80)}"`);
			rows.push({sha, message: record.slice(at + 1).trim()});
		}
		return ok(rows);
	});

/** The merge base of two commits, as a full object name. */
export const mergeBase = (a: string, b: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["merge-base", a, b]);
		if (!r.ok) return fail(r.reason);
		const sha = r.stdout.trim();
		return isObjectName(sha) ? ok(sha) : fail(`git named no merge base (got "${sha}")`);
	});

/** One commit on the walked ref: its object name and its committer date. */
export interface CommitRow {
	readonly sha: string;
	/** `YYYY-MM-DD`, taken from the committer date in UTC. */
	readonly date: string;
}

/**
 * The UTC calendar day of a strict-ISO instant, or `null` when it is not one.
 *
 * git's `%cI` carries the committer's own offset, so the day is read after normalizing to UTC — a
 * `--date=…-local` format would answer differently on two machines and make one window enumerate
 * two different sets.
 */
export const utcDayOf = (iso: string): string | null => {
	const at = Date.parse(iso.trim());
	return Number.isNaN(at) ? null : (new Date(at).toISOString().slice(0, 10) ?? null);
};

/**
 * The commits on `ref` inside an inclusive `YYYY-MM-DD` window that touch `dir`, oldest first.
 *
 * The bounds are stamped `Z` on purpose: bare dates make git read the caller's local zone, so the
 * same window would enumerate different commits on two machines.
 */
export const logCommitsTouching = (
	ref: string,
	since: string,
	until: string,
	dir: string,
): Shell<Attempt<ReadonlyArray<CommitRow>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [
			"log",
			"--reverse",
			"--format=%H%x09%cI",
			`--since=${since}T00:00:00Z`,
			`--until=${until}T23:59:59Z`,
			ref,
			"--",
			dir,
		]);
		if (!r.ok) return fail(r.reason);
		const rows: CommitRow[] = [];
		for (const line of r.stdout.split("\n")) {
			if (line.trim() === "") continue;
			const [sha, stamp] = line.split("\t");
			const date = stamp === undefined ? null : utcDayOf(stamp);
			if (sha === undefined || date === null) return fail(`unreadable log line "${line}"`);
			rows.push({sha, date});
		}
		return ok(rows);
	});

/** The paths one commit changes under `dir`, with their change letters. */
export const commitStatuses = (
	sha: string,
	dir: string,
): Shell<Attempt<ReadonlyArray<ChangedPath>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", [
			"show",
			...DIFF_FLAGS,
			"--name-status",
			"-z",
			"--format=",
			sha,
			"--",
			dir,
		]);
		return r.ok ? ok(parseNameStatus(r.stdout)) : fail(r.reason);
	});

/** One commit's own unified diff, under the same config-proof flags every range read uses. */
export const commitDiff = (sha: string): Shell<Attempt<string>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["show", ...DIFF_FLAGS, "--format=", sha]);
		return r.ok ? ok(r.stdout) : fail(r.reason);
	});

/** Whether this clone is shallow — the precondition a window walk's completeness rests on. */
export const isShallowClone: Shell<Attempt<boolean>> = Effect.gen(function* () {
	const r = yield* execCapture("git", ["rev-parse", "--is-shallow-repository"]);
	return r.ok ? ok(r.stdout.trim() === "true") : fail(r.reason);
});

/**
 * The dates of `ref`'s parentless commits, in UTC `YYYY-MM-DD`.
 *
 * In a shallow clone the graft boundary *is* a parentless commit, so these are the dates a window
 * has to clear to be provably complete.
 */
export const parentlessCommitDates = (ref: string): Shell<Attempt<ReadonlyArray<string>>> =>
	Effect.gen(function* () {
		const r = yield* execCapture("git", ["log", "--max-parents=0", "--format=%cI", ref]);
		if (!r.ok) return fail(r.reason);
		const days: string[] = [];
		for (const line of r.stdout.split("\n")) {
			if (line.trim() === "") continue;
			const day = utcDayOf(line);
			if (day === null) return fail(`unreadable boundary date "${line.trim()}"`);
			days.push(day);
		}
		return ok(days);
	});
