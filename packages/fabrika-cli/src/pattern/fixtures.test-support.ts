/**
 * The fixture bytes the contract's worked examples are stated against, scripted onto the git seam.
 *
 * The examples name fixtures committed in the skill's own tree, and the read-at-`--base` rule
 * applies to them like anything else — so what a verb actually sees is `git show <sha>:<path>`
 * output. Scripting **those bytes** reproduces the examples through the same seam production uses,
 * and it does so without a checkout: a test that shelled out to a real repository would be asserting
 * against that repository's history rather than against the spec.
 *
 * The bytes are read FROM the fixture files, never copied beside them (#5362). A copy is a fact that
 * goes stale without telling anyone — `PLAIN_DOC` shipped 93 bytes against a 179-byte file and
 * nothing red — so the file on disk is the one source, and a fixture that moved or emptied fails the
 * read loudly rather than scripting the seam with nothing.
 *
 * What each fixture is for is stated in the fixture's own opening prose; read the file rather than a
 * gloss of it here.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

/** The three fixture directory paths the contract's examples pass to `--dir`. */
export const FIXTURES = "claude-plugins/fabrika/skills/write-pattern/evals/fixtures";

/**
 * An empty read is a failed read, never fixture bytes — `""` scripted onto the seam satisfies every
 * assertion vacuously (ADR 0092). Kept separate from the read so the refusal is provable without an
 * empty file in the tree.
 */
export const nonEmptyFixture = (relativePath: string, bytes: string): string => {
	if (bytes.trim() === "") {
		throw new Error(
			`fixture ${FIXTURES}/${relativePath} read as empty — refusing to script the git seam with nothing`,
		);
	}
	return bytes;
};

/**
 * Resolved from this module rather than from the process cwd, the way the `wire` group resolves its
 * committed index doc — the fixtures live in the checkout this file ships in, wherever vitest ran.
 */
export const fixtureBytes = (relativePath: string): string =>
	nonEmptyFixture(
		relativePath,
		readFileSync(
			fileURLToPath(new URL(`../../../../${FIXTURES}/${relativePath}`, import.meta.url)),
			"utf8",
		),
	);

export const ANCHORED_DOC = fixtureBytes("anchored/worker-queue-retry.md");
export const PLAIN_DOC = fixtureBytes("anchored/plain-doc.md");
export const FIXTURE_MANIFEST = fixtureBytes("anchored/workspace.yaml");
export const UNANCHORED_DOC = fixtureBytes("unanchored-doc/worker-queue-retry.md");
export const THREE_SECTIONS_INDEX = fixtureBytes("three-sections/index.md");
