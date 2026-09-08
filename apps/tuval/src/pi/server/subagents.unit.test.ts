/**
 * The `piSubagents` flag's two answers, proved against the installed extension rather than against
 * a name: the flag off is no extension path at all, and the flag on is a package Pi's own loader
 * reads `subagent` and `bg_wait` out of.
 *
 * The loading half runs here rather than in the integration tier on purpose — it needs no model, no
 * socket and no credentials. What it does need is `node_modules`, so it reads the real installed
 * package and would red on a pin whose extension no longer registers those two tools.
 */

import {mkdtempSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SettingsManager} from "@earendil-works/pi-coding-agent";
import {describe, expect, it} from "vitest";
import {featuresDefault} from "../../features.ts";
import {extensionLoader} from "./AgentSessionHost.ts";
import {SUBAGENTS_PACKAGE, subagentExtensionPaths, subagentsPackageDir} from "./subagents.ts";

const toolNames = async (paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>> => {
	const cwd = mkdtempSync(join(tmpdir(), "tuval-subagents-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "tuval-subagents-agent-"));
	const loader = await extensionLoader(paths, cwd, agentDir, SettingsManager.create(cwd, agentDir));
	if (loader === undefined) return [];
	const loaded = loader.getExtensions();
	expect(loaded.errors).toEqual([]);
	return loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
};

describe("the piSubagents flag", () => {
	it("ships off, so a Pi row opens the session it opened before it existed", () => {
		expect(featuresDefault.piSubagents).toBe(false);
		expect(subagentExtensionPaths({piSubagents: false})).toEqual([]);
	});

	it("names the installed pi-subagents package when it is on", () => {
		const paths = subagentExtensionPaths({piSubagents: true});
		expect(paths).toHaveLength(1);
		const manifest = JSON.parse(readFileSync(join(paths[0] as string, "package.json"), "utf8")) as {
			readonly name: string;
			readonly pi: {readonly extensions: ReadonlyArray<string>};
		};
		expect(manifest.name).toBe(SUBAGENTS_PACKAGE);
		expect(manifest.pi.extensions).toContain("./index.ts");
		expect(paths[0]).toBe(subagentsPackageDir());
	});
});

describe("what Pi's own loader registers", () => {
	it("registers the subagent tools when the flag is on", async () => {
		const names = await toolNames(subagentExtensionPaths({piSubagents: true}));
		expect(names).toContain("subagent");
		expect(names).toContain("bg_wait");
	});

	it("registers nothing when the flag is off", async () => {
		expect(await toolNames(subagentExtensionPaths({piSubagents: false}))).toEqual([]);
	});
});
