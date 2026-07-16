/**
 * The generic boundary (AC 4): no `edge/` source file imports from `crew/`. edge/ codes
 * against the `peer/`+`protocol/` substrate and opaque role/peer parameters only — the
 * concrete crew role catalog + wiring is the `crew/` composition root (#3059). Mirrors the
 * same guard `peer/` and `protocol/` carry.
 */
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";

describe("edge/ generic boundary", () => {
	it("no edge source file imports from crew/", () => {
		const dir = fileURLToPath(new URL(".", import.meta.url));
		const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
		assert.isAbove(sources.length, 0, "expected edge/ source files to scan");
		for (const file of sources) {
			const body = readFileSync(new URL(file, new URL(".", import.meta.url)), "utf8");
			assert.isFalse(/from\s+["'][^"']*crew/.test(body), `${file} imports from crew/`);
		}
	});
});
