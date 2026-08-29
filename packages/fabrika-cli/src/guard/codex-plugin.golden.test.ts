import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";

const readJson = <A>(path: string): A =>
	JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as A;

interface CodexPlugin {
	readonly name: string;
	readonly skills: string;
}

interface CodexMarketplace {
	readonly plugins: ReadonlyArray<{
		readonly name: string;
		readonly source: {readonly source: string; readonly path: string};
		readonly policy: {readonly installation: string; readonly authentication: string};
		readonly category: string;
	}>;
}

const plugin = readJson<CodexPlugin>("../../../../codex-plugins/fabrika/.codex-plugin/plugin.json");
const marketplace = readJson<CodexMarketplace>("../../../../.agents/plugins/marketplace.json");

const files = (path: URL): ReadonlyArray<string> => {
	const root = fileURLToPath(path);
	return readdirSync(root, {recursive: true, withFileTypes: true})
		.filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name)))
		.sort();
};

describe("the Codex fabrika adapter", () => {
	it("loads the canonical skill corpus", () => {
		expect(plugin).toMatchObject({name: "fabrika", skills: "./skills/"});
		for (const skill of ["report", "triage", "build", "review", "ship"]) {
			const adapter = new URL(
				`../../../../codex-plugins/fabrika/skills/${skill}/`,
				import.meta.url,
			);
			const canonical = new URL(
				`../../../../claude-plugins/fabrika/skills/${skill}/`,
				import.meta.url,
			);
			expect(files(adapter)).toEqual(files(canonical));
			for (const file of files(canonical)) {
				expect(readFileSync(new URL(file, adapter))).toEqual(
					readFileSync(new URL(file, canonical)),
				);
			}
		}
	});

	it("publishes that same plugin through the repo marketplace", () => {
		expect(marketplace.plugins).toContainEqual({
			name: "fabrika",
			source: {source: "local", path: "./codex-plugins/fabrika"},
			policy: {installation: "AVAILABLE", authentication: "ON_INSTALL"},
			category: "Developer Tools",
		});
	});
});
