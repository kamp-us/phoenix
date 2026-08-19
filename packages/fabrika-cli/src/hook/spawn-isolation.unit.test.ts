/**
 * ADR 0238 as a check, not as a reviewer's eye: the ported spawn guard reaches v1 in no way at all.
 *
 * "Reimplement, never call" is only worth something if calling is caught. The three files below are
 * the whole of the port, so the reach they may have is bounded here — no import of v1, and no
 * subprocess that could shell out to it behind an import's back.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const PORTED = ["../models.ts", "./spawn.ts", "./spawn-verb.ts"] as const;

const sourceOf = (relative: string): string =>
	readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the ported spawn guard's reach", () => {
	it.each(PORTED)("%s names nothing outside fabrika", (relative) => {
		const source = sourceOf(relative);
		for (const line of source.split("\n")) {
			// The docblocks cite v1's issue numbers, which is the point of a port — what may not appear
			// is an `import`/`require`/`from` that resolves into v1.
			if (!/\b(?:import|require|from)\b/.test(line)) continue;
			expect(line).not.toContain("kampus-pipeline");
		}
	});

	it.each(PORTED)("%s spawns no process, so nothing shells out to v1 either", (relative) => {
		const source = sourceOf(relative);
		expect(source).not.toContain("node:child_process");
		expect(source).not.toContain("execFile");
		expect(source).not.toContain("spawnSync");
	});
});
