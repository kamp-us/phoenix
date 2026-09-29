/**
 * `fabrika --version` reports what shipped. The derivation is the only thing that can regress,
 * so that is what these assertions read.
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
});
