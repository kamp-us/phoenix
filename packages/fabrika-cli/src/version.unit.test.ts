/**
 * `fabrika --version` reports what shipped (#5714).
 *
 * This VERSION was the unasserted carrier: nothing failed when a release bumped `package.json`
 * and left the literal behind, so the CLI shipped lying about itself through `run.ts` and
 * `delegate/entry.ts`. Deriving it from `package.json` makes the equality true by construction,
 * which leaves the derivation as the only thing that can regress.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {VERSION} from "./version.ts";

const packagePath = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

describe("the fabrika-cli version carrier", () => {
	it("reports the package's own version", () => {
		const pkg = JSON.parse(readFileSync(packagePath("package.json"), "utf8")) as {
			version: string;
		};
		assert.strictEqual(VERSION, pkg.version);
	});

	it("derives that version rather than declaring one", () => {
		const src = readFileSync(packagePath("src/version.ts"), "utf8");
		assert.include(
			src,
			'import pkg from "../package.json" with {type: "json"}',
			"src/version.ts must read the package's own package.json",
		);
		assert.notMatch(
			src,
			/export const VERSION\s*=\s*["'`]/,
			"src/version.ts must not re-declare a version literal — package.json is the one carrier release-please bumps",
		);
	});
});
