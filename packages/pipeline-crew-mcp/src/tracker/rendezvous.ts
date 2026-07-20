/**
 * tracker/rendezvous — how a crew peer finds the ONE registry for its repo.
 *
 * The rendezvous is per-repo and canonical: keyed on the main checkout's SHARED git dir
 * (`git rev-parse --git-common-dir`), so the main checkout, any nested subdirectory of it, and every
 * `isolation:worktree` linked worktree of it all resolve to the same socket, while different repos on
 * one machine stay isolated. See ADR 0197.
 *
 * The one non-obvious thing, and the trap the whole module is shaped around: `--git-common-dir` is
 * printed RELATIVE TO THE CWD IT RAN IN. From the repo root it prints `.git`; from `repo/apps/web` it
 * prints `../../.git`; from a linked worktree it prints an absolute path. So the raw string is not a
 * key — it must be resolved against that same cwd and symlink-canonicalized before it is hashed, or
 * the exact `repo` vs `repo/apps/web` split this module exists to kill comes straight back.
 *
 * ADR 0197 left open how much of the surrounding ceremony a canonical rendezvous retires. The finding
 * is: only the cwd-derived hashing. First-peer host-or-dial and stale-socket reclaim (`./server.ts`)
 * both SURVIVE, because neither was arbitrating *which* socket — they arbitrate a unix bind. Two
 * panes still start concurrently and still contend for one now-agreed path (`EADDRINUSE` is what
 * makes the second dial instead of die), and a SIGKILL'd host still strands its socket file. Canonical
 * addressing makes that contention converge on one registry; it does not remove it.
 */
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {isAbsolute, join, normalize, resolve} from "node:path";
import {Effect} from "effect";
import * as Schema from "effect/Schema";

/** A repo has no canonical rendezvous when git can't name its shared dir — an error, never a fallback (ADR 0197). */
export class RendezvousResolutionError extends Schema.TaggedErrorClass<RendezvousResolutionError>()(
	"@kampus/pipeline-crew-mcp/tracker/RendezvousResolutionError",
	{startDir: Schema.String, reason: Schema.String},
) {}

/** The canonical meeting point for one repo: the key every peer of it agrees on, and the socket it serves. */
export interface Rendezvous {
	/** The main checkout's shared git dir, absolute and symlink-resolved — the identity of the repo. */
	readonly repoKey: string;
	/** The unix socket derived from `repoKey` — where the tracker for this repo listens. */
	readonly socketPath: string;
}

/**
 * Turn a raw `git rev-parse --git-common-dir` reading into the canonical repo key: resolve it against
 * the cwd git ran in (the reading is relative to exactly that dir), then follow symlinks so the main
 * checkout and its worktrees land on one byte-identical string. A nonexistent path can't be
 * `realpath`'d, so it degrades to a plain normalize rather than throwing — resolution failure is the
 * caller's error channel, not this pure boundary's.
 */
export const canonicalizeGitCommonDir = (rawGitCommonDir: string, cwd: string): string => {
	const absolute = isAbsolute(rawGitCommonDir) ? rawGitCommonDir : resolve(cwd, rawGitCommonDir);
	return existsSync(absolute) ? realpathSync(absolute) : normalize(absolute);
};

/**
 * The rendezvous socket for a canonical `repoKey`. Hashed rather than embedded so the path stays under
 * the ~104-char unix socket limit; honors `XDG_RUNTIME_DIR`, falling back to the OS temp dir.
 */
export const rendezvousSocketPathFor = (repoKey: string): string => {
	const digest = createHash("sha256").update(repoKey).digest("hex").slice(0, 16);
	const base = process.env.XDG_RUNTIME_DIR ?? tmpdir();
	return join(base, `kampus-crew-${digest}.sock`);
};

/** Ask git, from `startDir`, for this repo's shared git dir. */
const readGitCommonDir = (startDir: string): Effect.Effect<string, RendezvousResolutionError> =>
	Effect.try({
		try: () =>
			execFileSync("git", ["rev-parse", "--git-common-dir"], {
				cwd: startDir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim(),
		catch: (cause) =>
			new RendezvousResolutionError({
				startDir,
				reason: `git rev-parse --git-common-dir failed: ${String(cause)}`,
			}),
	}).pipe(
		Effect.flatMap((reading) =>
			reading.length > 0
				? Effect.succeed(reading)
				: Effect.fail(
						new RendezvousResolutionError({
							startDir,
							reason: "git rev-parse --git-common-dir printed nothing",
						}),
					),
		),
	);

// Resolved once per start dir and held for the process lifetime (ADR 0197: resolve once, never
// re-derive from a later cwd) — a crew process that later chdirs still rendezvous where it started.
const resolvedRendezvous = new Map<string, Rendezvous>();

/**
 * Resolve the canonical rendezvous for the repo containing `startDir`. `startDir` seeds git's repo
 * discovery only — it is never itself the key, so two callers passing `repo` and `repo/apps/web` (or a
 * linked worktree of either) get the same `repoKey` and the same socket.
 */
export const resolveRendezvous = (
	startDir: string,
): Effect.Effect<Rendezvous, RendezvousResolutionError> =>
	Effect.suspend(() => {
		const cached = resolvedRendezvous.get(startDir);
		if (cached !== undefined) return Effect.succeed(cached);
		return readGitCommonDir(startDir).pipe(
			Effect.map((reading) => {
				const repoKey = canonicalizeGitCommonDir(reading, startDir);
				const rendezvous: Rendezvous = {repoKey, socketPath: rendezvousSocketPathFor(repoKey)};
				resolvedRendezvous.set(startDir, rendezvous);
				return rendezvous;
			}),
		);
	});

/** The rendezvous socket for the repo containing `startDir` — the common case of `resolveRendezvous`. */
export const rendezvousSocketPath = (
	startDir: string,
): Effect.Effect<string, RendezvousResolutionError> =>
	resolveRendezvous(startDir).pipe(Effect.map((rendezvous) => rendezvous.socketPath));
