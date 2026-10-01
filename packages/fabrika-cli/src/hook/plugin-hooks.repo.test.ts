/**
 * Keeps the plugin's hook declaration where Claude Code looks for it.
 *
 * Claude Code loads a plugin's hooks from `hooks/hooks.json` under the plugin root, merged with
 * whatever the manifest's `hooks` field names. A `hooks.json` at the plugin root is read by
 * nothing: the declaration sat there once, no hook ran in any session, and every other test stayed
 * green because each one reads the file wherever it is. The manifest stays without a `hooks` field,
 * since one naming the default file would load the same hooks a second time.
 *
 * @see https://code.claude.com/docs/en/plugins-reference
 */
import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {declaredHooks} from "./declaration.ts";

const PLUGIN_ROOT = new URL("../../../../claude-plugins/fabrika/", import.meta.url);

const at = (relative: string): string => fileURLToPath(new URL(relative, PLUGIN_ROOT));
const readJson = (relative: string): unknown => JSON.parse(readFileSync(at(relative), "utf8"));

describe("the plugin's hook declaration", () => {
	it("sits at hooks/hooks.json and declares hooks", () => {
		expect(existsSync(at("hooks/hooks.json"))).toBe(true);
		expect(declaredHooks(readJson("hooks/hooks.json")).length).toBeGreaterThan(0);
	});

	it("has no root-level hooks.json, which Claude Code never loads", () => {
		expect(existsSync(at("hooks.json"))).toBe(false);
	});

	it("is found by its location, so the manifest names no hooks", () => {
		expect(readJson(".claude-plugin/plugin.json")).not.toHaveProperty("hooks");
	});
});
