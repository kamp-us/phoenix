/**
 * `portability-guard`'s matchers and its ceiling arithmetic.
 *
 * Both halves of every rule are pinned: the reference it must catch, and the lookalike it must not.
 * A guard that reds a markdown heading or a hex colour is one somebody turns off, and a guard that
 * reds the synthetic ticket number a test asserts against would force the test to stop naming it.
 */
import {describe, expect, it} from "vitest";
import {judge, type PortabilityConfig, renderReport, scanFile} from "./portability.ts";

const PLUGIN = "claude-plugins/fabrika/skills/build/SKILL.md";

const kinds = (path: string, text: string, names: ReadonlyArray<string> = []) =>
	scanFile(path, text, names).map((hit) => hit.pattern);

describe("scanFile", () => {
	it("catches a ticket number, in prose and in a code docblock alike", () => {
		expect(kinds(PLUGIN, "The lane parked twice on this shape (#6037).")).toEqual(["issue"]);
		expect(
			kinds("packages/fabrika-cli/src/lane/report.ts", " * See #4312 for the incident."),
		).toEqual(["issue"]);
	});

	it("catches a decision-record number in the bare and the linked spelling", () => {
		expect(kinds(PLUGIN, "Fail-closed per ADR 0092.")).toEqual(["decision-number"]);
		expect(kinds(PLUGIN, "per ADR [0092](../../../../.decisions/0092-guards.md)")).toEqual([
			"decision-number",
			"decision-link",
		]);
	});

	it("catches a hosted issue or pull-request URL whoever owns the repository", () => {
		expect(kinds(PLUGIN, "see https://github.com/some-org/some-repo/issues/12")).toEqual(["url"]);
		expect(kinds(PLUGIN, "see https://github.com/some-org/some-repo/pull/9")).toEqual(["url"]);
	});

	it("catches a declared repo name, case-insensitively and only as a whole word", () => {
		expect(kinds(PLUGIN, "In Phoenix the gate runs on push.", ["phoenix"])).toEqual(["repo-name"]);
		expect(kinds(PLUGIN, "the phoenixlike shape", ["phoenix"])).toEqual([]);
		expect(kinds(PLUGIN, "copy lives under apps/web/src", ["apps/web"])).toEqual(["repo-name"]);
		expect(kinds(PLUGIN, "the sözlük alphabet", ["sözlük"])).toEqual(["repo-name"]);
	});

	it("leaves a markdown heading and a hex colour alone", () => {
		expect(kinds(PLUGIN, "## 3 — Read the contract")).toEqual([]);
		expect(kinds(PLUGIN, "background: #fff; border: #1a1a1a;")).toEqual([]);
	});

	it("leaves a ticket number that is test data, and still reads the narration around it", () => {
		const test = "packages/fabrika-cli/src/lane/report.unit.test.ts";
		expect(kinds(test, '\t\texpect(refsIn("closes #4789")).toEqual([4789]);')).toEqual([]);
		expect(kinds(test, "\t// the two-marker shape #6691 left behind")).toEqual(["issue"]);
		expect(
			kinds("packages/fabrika-cli/src/build/__fixtures__/epic.body.txt", "Part of #4300"),
		).toEqual([]);
	});

	it("scans none of its own files, so the guard may spell out what it forbids", () => {
		expect(kinds("packages/fabrika-cli/src/guard/portability.ts", "ADR 0092 and #6037")).toEqual(
			[],
		);
	});

	it("reports the line a reference sits on", () => {
		expect(scanFile(PLUGIN, "clean\nclean\ncarrying #4312\n", [])).toEqual([
			{line: 3, pattern: "issue", matched: "#4312"},
		]);
	});
});

const config = (over: Partial<PortabilityConfig> = {}): PortabilityConfig => ({
	exempt: {},
	unmigrated: {},
	...over,
});

const file = (path: string, hits: number) => ({
	path,
	hits: Array.from({length: hits}, (_, i) => ({
		line: i + 1,
		pattern: "issue" as const,
		matched: "#4312",
	})),
});

describe("judge", () => {
	it("reds a scan that covered nothing rather than calling it clean", () => {
		expect(judge({files: [], config: config()})._tag).toBe("ZeroScope");
	});

	it("reds a reference no row covers, naming the file", () => {
		const verdict = judge({files: [file(PLUGIN, 1)], config: config()});
		expect(verdict._tag).toBe("Violation");
		if (verdict._tag !== "Violation") return;
		expect(verdict.unlisted.map((f) => f.path)).toEqual([PLUGIN]);
	});

	it("passes a floor row whose count equals its ceiling, and reds one over it", () => {
		const unmigrated = {
			"plugin-build": {
				ceiling: 2,
				why: "swept later",
				paths: ["claude-plugins/fabrika/skills/build"],
			},
		};
		expect(judge({files: [file(PLUGIN, 2)], config: config({unmigrated})})._tag).toBe("Clean");
		expect(judge({files: [file(PLUGIN, 3)], config: config({unmigrated})})._tag).toBe("Violation");
	});

	it("reds a floor row whose ceiling now sits above the count — the floor only shrinks", () => {
		const verdict = judge({
			files: [file(PLUGIN, 1)],
			config: config({
				unmigrated: {
					"plugin-build": {
						ceiling: 4,
						why: "swept later",
						paths: ["claude-plugins/fabrika/skills/build"],
					},
				},
			}),
		});
		expect(verdict._tag).toBe("Violation");
		if (verdict._tag !== "Violation") return;
		expect(verdict.stale.map((row) => row.key)).toEqual(["plugin-build"]);
		expect(renderReport("guard portability-guard check", verdict)).toContain(
			"lower the ceiling to 1",
		);
	});

	it("gives a file to the longest matching prefix, so a catch-all row cannot swallow a unit", () => {
		const verdict = judge({
			files: [file(PLUGIN, 1)],
			config: config({
				unmigrated: {
					"plugin-build": {
						ceiling: 1,
						why: "swept later",
						paths: ["claude-plugins/fabrika/skills/build"],
					},
					"plugin-tail": {ceiling: 1, why: "swept later", paths: ["claude-plugins/fabrika"]},
				},
			}),
		});
		expect(verdict._tag).toBe("Violation");
		if (verdict._tag !== "Violation") return;
		expect(verdict.stale.map((row) => row.key)).toEqual(["plugin-tail"]);
	});

	it("caps an exempt file rather than ratcheting it, so a permanent row may hold fewer", () => {
		const exempt = {[PLUGIN]: {ceiling: 3, why: "the manifest says where it is published"}};
		expect(judge({files: [file(PLUGIN, 1)], config: config({exempt})})._tag).toBe("Clean");
		expect(judge({files: [file(PLUGIN, 4)], config: config({exempt})})._tag).toBe("Violation");
	});
});
