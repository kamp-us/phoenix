/**
 * The drift guard on `.patterns/tuval-spells.md`: every repo path that page links to has to exist.
 *
 * A reference page whose file table names a module that moved sends its reader nowhere, and nothing
 * else in CI reads it. So this resolves each markdown link target the doc carries and stats it. The
 * doc must also carry at least one, otherwise a page that lost its whole table would pass silently.
 */

import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {join, normalize, resolve} from "node:path";
import {describe, expect, it} from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const docPath = join(repoRoot, ".patterns/tuval-spells.md");

/** Every `[text](target)` whose target is a relative path, deduped, in document order. */
const linkedPaths = (markdown: string): ReadonlyArray<string> => {
	const targets = new Set<string>();
	for (const match of markdown.matchAll(/\]\((\.[^)\s]+)\)/g)) {
		const target = match[1];
		if (target !== undefined) targets.add(target.split("#")[0] ?? target);
	}
	return [...targets];
};

describe(".patterns/tuval-spells.md", () => {
	it("links only to paths that exist", async () => {
		const markdown = await readFile(docPath, "utf8");
		const targets = linkedPaths(markdown);

		expect(targets.length).toBeGreaterThan(0);

		const missing = targets.filter(
			(target) => !existsSync(normalize(join(repoRoot, ".patterns", target))),
		);
		expect(missing).toEqual([]);
	});

	it("cites the code it describes", async () => {
		const markdown = await readFile(docPath, "utf8");
		const cited = linkedPaths(markdown).filter((target) => target.includes("apps/tuval/src/"));

		expect(cited.length).toBeGreaterThan(20);
	});
});
