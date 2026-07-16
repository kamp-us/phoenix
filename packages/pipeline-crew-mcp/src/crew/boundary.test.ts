/**
 * The one-way boundary (AC 4): the generic substrate never imports the crew composition root.
 * `protocol/`, `tracker/`, `peer/`, and `edge/` are the reusable channels substrate and must
 * contain no import of `crew/`; only `crew/` imports them. Each generic module carries its own
 * mirror of this guard — this test asserts the whole boundary from the crew side, so the
 * disjointness is a checked fact, not a convention.
 */
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

const GENERIC_MODULES = ["protocol", "tracker", "peer", "edge"] as const;

describe("crew/ composition-root boundary", () => {
	it("no generic module source imports from crew/", () => {
		const srcDir = fileURLToPath(new URL("..", import.meta.url));
		let scanned = 0;
		for (const mod of GENERIC_MODULES) {
			const dir = new URL(`../${mod}/`, import.meta.url);
			const files = readdirSync(fileURLToPath(dir)).filter(
				(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
			);
			assert.isAbove(files.length, 0, `expected ${mod}/ source files to scan`);
			for (const file of files) {
				scanned += 1;
				const body = readFileSync(new URL(file, dir), "utf8");
				assert.isFalse(/from\s+["'][^"']*crew/.test(body), `${mod}/${file} imports from crew/`);
			}
		}
		assert.isAbove(scanned, 0, `expected generic sources under ${srcDir} to scan`);
	});
});
