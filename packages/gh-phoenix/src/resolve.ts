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
 * `$CLAUDE_PIPELINE_REPO`, else `gh repo view`, else the phoenix default.
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

/** Resolve `$CLAUDE_PIPELINE_REPO` or `gh repo view` — the repo the REST rewrites target. */
export const resolveRepo = (realGh: string | null): string => {
	const fromEnv = process.env.CLAUDE_PIPELINE_REPO;
	if (fromEnv && fromEnv.length > 0) return fromEnv;
	if (realGh) {
		try {
			return execFileSync(
				realGh,
				["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
				{encoding: "utf8"},
			).trim();
		} catch {
			/* fall through */
		}
	}
	return "kamp-us/phoenix";
};
