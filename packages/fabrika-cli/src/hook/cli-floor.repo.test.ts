/**
 * Keeps the plugin's declared CLI minimum honest.
 *
 * release-please writes the minimum in the same Release PR that bumps this package, so between
 * releases it equals the last released version. A hand edit, or a release whose config lost the
 * extra-file, leaves the two apart, and this test reds on either.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9675#issuecomment-5790600028
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import pkg from "../../package.json" with {type: "json"};
import {CLI_FLOOR_FILE, CLI_PACKAGE} from "./cli-floor.ts";

const REPO_ROOT = new URL("../../../../", import.meta.url);
const FLOOR_PATH = `claude-plugins/fabrika/${CLI_FLOOR_FILE}`;

const readJson = (relative: string): Record<string, unknown> =>
	JSON.parse(readFileSync(fileURLToPath(new URL(relative, REPO_ROOT)), "utf8"));

describe("the plugin's declared CLI minimum", () => {
	it("names this package", () => {
		expect(pkg.name).toBe(CLI_PACKAGE);
	});

	it("equals this package's version, so no hand edit can move it", () => {
		expect(readJson(FLOOR_PATH).minimum).toBe(pkg.version);
	});

	it("is written by release-please in this package's Release PR", () => {
		const config = readJson("release-please-config.json") as {
			packages: Record<string, {"extra-files"?: ReadonlyArray<unknown>}>;
		};
		expect(config.packages["packages/fabrika-cli"]?.["extra-files"]).toContainEqual({
			type: "json",
			path: `/${FLOOR_PATH}`,
			jsonpath: "$.minimum",
		});
	});
});
