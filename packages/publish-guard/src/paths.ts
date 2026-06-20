/**
 * Repo-root-relative path resolution for the `publish-guard` bin (#807).
 *
 * The bin runs from source (`node packages/publish-guard/src/bin.ts`) wherever
 * the repo is checked out, so it derives the repo root from its own module URL —
 * `src/` sits two dirs under `packages/publish-guard`, three under the repo root
 * — rather than trusting `process.cwd()`. The two scan roots hang off that:
 * the skills tree it derives the required set from, and the `packages/` dir it
 * loads each required manifest from.
 *
 * `PUBLISH_GUARD_ROOT` overrides the derived root (a fixture tree for the bin's
 * end-to-end test) — the one seam that lets the drift-exits-non-zero AC be
 * proven deterministically without mutating the live repo's package.jsons.
 */
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const derivedRoot = (): string => {
	const here = dirname(fileURLToPath(import.meta.url)); // packages/publish-guard/src
	return join(here, "..", "..", "..");
};

export const REPO_ROOT = process.env.PUBLISH_GUARD_ROOT ?? derivedRoot();

export const SKILLS_DIR = join(REPO_ROOT, "claude-plugins", "kampus-pipeline", "skills");
export const PACKAGES_DIR = join(REPO_ROOT, "packages");
