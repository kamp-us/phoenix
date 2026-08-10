import {describe, expect, it} from "vitest";
import {insideRoot, resolveSkillRoots, skillRootsIn} from "./skill-root.ts";

describe("resolveSkillRoots", () => {
	it("resolves the one install and returns its directory", () => {
		expect(
			resolveSkillRoots([
				"claude-plugins/fabrika/skills/governance/SKILL.md",
				"claude-plugins/fabrika/skills/review/SKILL.md",
			]),
		).toEqual({_tag: "One", root: "claude-plugins/fabrika/skills/governance/"});
	});

	it("does NOT match a repo-root `skills/` tree — the plugin segment is part of the pattern", () => {
		expect(resolveSkillRoots(["skills/governance/SKILL.md"])).toEqual({_tag: "None"});
	});

	it("matches an install at any depth, so a foreign repo's layout still resolves", () => {
		expect(resolveSkillRoots(["vendor/plugins/fabrika/skills/governance/SKILL.md"])).toEqual({
			_tag: "One",
			root: "vendor/plugins/fabrika/skills/governance/",
		});
	});

	it("names every candidate when two installs are present rather than picking one", () => {
		const roots = resolveSkillRoots([
			"b/fabrika/skills/governance/SKILL.md",
			"a/fabrika/skills/governance/SKILL.md",
		]);
		expect(roots).toEqual({
			_tag: "Many",
			candidates: ["a/fabrika/skills/governance/", "b/fabrika/skills/governance/"],
		});
	});

	it("answers None over an empty tree, which is a fact and not an error", () => {
		expect(resolveSkillRoots([])).toEqual({_tag: "None"});
		expect(skillRootsIn([])).toEqual([]);
	});
});

describe("insideRoot", () => {
	const root = "claude-plugins/fabrika/skills/governance/";

	it("admits a path under the root", () => {
		expect(insideRoot(root, `${root}contract.md`)).toBe(true);
	});

	it("refuses a sibling skill's text, which is what the fence exists for", () => {
		expect(insideRoot(root, "claude-plugins/fabrika/skills/review/SKILL.md")).toBe(false);
	});

	it("refuses the root itself — a directory carries no bytes to read", () => {
		expect(insideRoot(root, root)).toBe(false);
	});
});
