/**
 * The per-keystroke budget. The palette calls `parse` and `complete` on every key, so the pair has
 * to finish well inside a frame against a full registry — synchronous, no scheduling, no worker.
 *
 * The assertion is the median of the runs, not the mean or the maximum: one run of a JIT-warmed
 * pure function is dominated by whatever the runtime did around it, and a CI runner is a noisy
 * machine. The median is the honest per-keystroke cost.
 */

import {describe, expect, it} from "vitest";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import {complete} from "./complete.ts";
import {jsonSchema, snapshot} from "./fixtures.ts";
import {parse} from "./parse.ts";
import {buildSpellIndex} from "./spell-index.ts";

const GROUPS = ["window", "workspace", "process", "layout", "focus", "editor", "panel", "session"];
const VERBS = ["open", "close", "move", "swap", "rename", "activate", "split", "focus"];

const descriptions: RegistryDescription = Array.from({length: 200}, (_, index) => ({
	path: [
		GROUPS[index % GROUPS.length]!,
		VERBS[Math.floor(index / GROUPS.length) % VERBS.length]!,
		`variant-${index}`,
	],
	describe: `spell number ${index}`,
	params: jsonSchema({workspace: {type: "string"}, label: {type: "string"}}, ["workspace"]),
	capabilities: [],
}));

const registry = buildSpellIndex(descriptions);

// 40 characters, and the caret sits on a fuzzy live-value argument — the most expensive slot.
const INPUT = "workspace activate variant-41 super-carr";

const medianMicroseconds = (iterations: number): number => {
	const samples: Array<number> = [];
	for (let run = 0; run < iterations; run += 1) {
		const started = performance.now();
		parse(INPUT, registry, snapshot);
		complete(INPUT, registry, snapshot);
		samples.push((performance.now() - started) * 1000);
	}
	return samples.sort((left, right) => left - right)[Math.floor(samples.length / 2)]!;
};

describe("per-keystroke budget", () => {
	it("parses and completes a 40-character input against 200 spells under a millisecond", () => {
		expect(INPUT.length).toBe(40);
		expect(registry.spells.length).toBe(200);
		medianMicroseconds(200);
		expect(medianMicroseconds(500)).toBeLessThan(1000);
	});
});
