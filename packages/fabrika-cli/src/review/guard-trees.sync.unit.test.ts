/**
 * The guard-probe table's sync golden: every probe cites the guard source file and constant it was
 * composed from, and this test re-reads that source to assert the constant is still exported there.
 *
 * This is what makes the refusal union *derived* rather than hardcoded — a guard that renames or
 * moves its corpus reds here, instead of silently shrinking what the ocr-port filter refuses to
 * blind (ADR 0180's captured-payload discipline, applied to a source citation instead of a wire
 * payload).
 */
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {guardProbes, governedRootProbes} from "./guard-trees.ts";

const srcDir = dirname(fileURLToPath(import.meta.url));

describe("the guard-probe citations", () => {
	it("each probe's constant is still exported by the guard source it cites", () => {
		for (const probe of guardProbes()) {
			const [file, symbol] = probe.source.split(":");
			expect(file, probe.source).toBeTruthy();
			expect(symbol, probe.source).toBeTruthy();
			const text = readFileSync(join(srcDir, "..", file?.replace(/^src\//, "") ?? ""), "utf8");
			expect(text, probe.source).toContain(`export const ${symbol}`);
		}
	});

	it("the governed-root probes key off the runtime roots, not a copied list", () => {
		expect(governedRootProbes([".decisions/", "claude-plugins/"]).map((probe) => probe.path)).toEqual([
			".decisions/probe.md",
			"claude-plugins/probe.md",
		]);
		expect(governedRootProbes([".fabrika.jsonc"]).map((probe) => probe.path)).toEqual([".fabrika.jsonc"]);
	});
});
