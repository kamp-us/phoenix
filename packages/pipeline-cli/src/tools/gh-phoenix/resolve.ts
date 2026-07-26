/**
 * The `gh` shim's real-binary + repo resolution — the branchy IO seam behind the
 * router (#743), split out of `bin.ts` so it is crossable over a fake PATH/FS in
 * unit tests rather than only by spawning the bin (the `router.ts` / `lint.ts`
 * core-in-its-own-file idiom; #855).
 *
 * `resolveRealGh` finds the REAL `gh` to forward to: `$GH_PHOENIX_REAL_GH`, else
 * the first executable `gh` on PATH whose realpath differs from this shim's — the
 * self-recursion guard that keeps the shim from execing itself. `self` is
 * injectable (default `selfPath`) so the self-skip is testable independent of the
 * runtime's `argv[1]`. `resolveRepo` resolves the repo the REST rewrites target:
 * `$CLAUDE_PIPELINE_REPO`, else `$GITHUB_REPOSITORY`, else `gh repo view` — and
 * `null` when none of them resolves.
 *
 * **Exempt from the epic #3462 `@effect/platform` sweep, adjudicated in #3934.** The raw
 * `node:fs` / `node:path` here is the bin-boundary case of
 * .patterns/effect-platform-access.md § "The bright line": every consumer is `bin.ts`'s
 * `runShim`, a *pre-Effect-runtime* argv dispatch that short-circuits before
 * `NodeRuntime.runMain`, so there is no runtime and no `NodeServices.layer` in scope to
 * `yield*` a service from. It is also synchronous by contract — `fileExists` is injected
 * into the sync `route` core as `bodyFileExists`, and `selfPath` is computed at module load
 * — so an effectful `FileSystem`/`Path` would have to make the router seam effectful to
 * reach it. The raw calls stay at this boundary and are never woven through a service
 * method, which is exactly what the bright line permits.
 */
import {execFileSync} from "node:child_process";
import {accessSync, constants, realpathSync} from "node:fs";
import {delimiter, join} from "node:path";

/** This binary's own resolved path, so PATH resolution can skip it (no self-recursion). */
export const selfPath = (() => {
	try {
		return realpathSync(process.argv[1] ?? "");
	} catch {
		return process.argv[1] ?? "";
	}
})();

export const isExecutable = (path: string): boolean => {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

export const fileExists = (path: string): boolean => {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
};

/**
 * Resolve the REAL `gh` to exec: `$GH_PHOENIX_REAL_GH` if set, else the first
 * executable `gh` on PATH whose realpath differs from `self` (this shim). Returns
 * null when no real `gh` exists — the shim then can't passthrough and reports that.
 */
export const resolveRealGh = (self: string = selfPath): string | null => {
	const explicit = process.env.GH_PHOENIX_REAL_GH;
	if (explicit && isExecutable(explicit)) return explicit;
	const dirs = (process.env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
	for (const dir of dirs) {
		const candidate = join(dir, "gh");
		if (!isExecutable(candidate)) continue;
		let resolved = candidate;
		try {
			resolved = realpathSync(candidate);
		} catch {
			/* use unresolved */
		}
		if (resolved !== self) return candidate;
	}
	return null;
};

/** A well-formed `owner/name` slug — the shape every REST rewrite path is built from. */
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/**
 * Resolve the repo the REST rewrites target, per ADR 0062 §1: `$CLAUDE_PIPELINE_REPO`,
 * else `$GITHUB_REPOSITORY` (the CI tier every sibling resolver in this package carries),
 * else `gh repo view`. **Returns `null` when none of them resolves** — an unresolved repo
 * is a value the caller must handle, never a default. A repo literal here turned a
 * resolution failure into a confident wrong target: a foreign repo's `gh pr edit <N>`
 * became a `PATCH` against whatever issue held that number in *this* repo (#4270).
 */
export const resolveRepo = (realGh: string | null): string | null => {
	const fromEnv = process.env.CLAUDE_PIPELINE_REPO ?? process.env.GITHUB_REPOSITORY;
	if (fromEnv && REPO_RE.test(fromEnv.trim())) return fromEnv.trim();
	if (realGh) {
		try {
			const viewed = execFileSync(
				realGh,
				["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
				{encoding: "utf8"},
			).trim();
			if (REPO_RE.test(viewed)) return viewed;
		} catch {
			/* unresolved — fall through */
		}
	}
	return null;
};
