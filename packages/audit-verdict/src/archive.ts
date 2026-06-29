/**
 * Where a verdict is archived — a repo-relative, run-over-run-accumulating path.
 *
 * Acceptance (#1516) and repo policy: the artifact and every path it cites are
 * REPO-RELATIVE only — never a home (`~`), absolute (`/…`), drive, or sibling-repo path.
 * `archivePath` constructs the path from a fixed repo-relative dir + a sanitized
 * timestamp + the stage, then `assertRepoRelative` fails loud if anything (a stage name,
 * an upstream override) smuggled in an escaping segment — the invalid state is made
 * unrepresentable at the seam that emits it.
 */
import type {Verdict} from "./schema.ts";

/** The accumulating run-log dir, repo-relative. Each run lands a `<stamp>-<stage>.{json,md}` pair. */
export const ARCHIVE_DIR = "rite-audit/runs";

/** Throw if `p` is not a clean repo-relative path (absolute, home, drive, or `..`-escaping). */
export const assertRepoRelative = (p: string): string => {
	const bad =
		p.startsWith("/") ||
		p.startsWith("~") ||
		p.startsWith("\\") ||
		/^[a-zA-Z]:[\\/]/.test(p) || // Windows drive
		p.split(/[\\/]/).includes("..");
	if (bad) {
		throw new Error(
			`audit-verdict: refusing to emit a non-repo-relative archive path: ${JSON.stringify(p)} (acceptance #1516 — repo-relative paths only)`,
		);
	}
	return p;
};

/** Filesystem-safe a timestamp: `2026-06-28T12:00:00.000Z` -> `2026-06-28T120000Z`. */
const stamp = (iso: string): string => iso.replace(/\.\d+Z$/, "Z").replace(/:/g, "");

/** Slugify a stage to the filename-safe charset, so a stage name can't escape the dir. */
const slugStage = (stage: string): string => stage.replace(/[^a-zA-Z0-9._-]/g, "-") || "stage";

/** The repo-relative archive path for one verdict's rendering — `rite-audit/runs/<stamp>-<stage>.<ext>`. */
export const archivePath = (verdict: Verdict, ext: "json" | "md"): string =>
	assertRepoRelative(
		`${ARCHIVE_DIR}/${stamp(verdict.date)}-${slugStage(verdict.target.stage)}.${ext}`,
	);
