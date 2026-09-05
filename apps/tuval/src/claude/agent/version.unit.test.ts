/**
 * `SDK_VERSION` against the two places that could disagree with it.
 *
 * The constant exists because the SDK exports no version and its `package.json` is not in its
 * `exports` map, so nothing can import it — and a constant nothing checks is a constant that goes
 * stale the first time Dependabot bumps the catalog. The `start` log line names it beside the CLI's
 * own `claude_code_version`, so a stale copy would report SDK/CLI drift that is not there.
 */

import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {SDK_VERSION} from "./sdk.ts";

const workspaceRoot = join(import.meta.dirname, "..", "..", "..", "..", "..");

describe("SDK_VERSION", () => {
	it("is the pnpm-workspace.yaml catalog pin", () => {
		const catalog = readFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8");
		const pinned = /^\s*'@anthropic-ai\/claude-agent-sdk':\s*(\S+)\s*$/m.exec(catalog)?.[1];
		expect(pinned).toBe(SDK_VERSION);
	});

	it("is the version actually installed in this tree", () => {
		// Not an import: the package's `exports` map does not publish `package.json`, so the file is
		// resolved through the module entry point and read off disk instead.
		const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
		const manifest = JSON.parse(readFileSync(join(entry, "..", "package.json"), "utf8")) as {
			version: string;
		};
		expect(manifest.version).toBe(SDK_VERSION);
	});
});
