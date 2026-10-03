import {describe, expect, it} from "vitest";
import {CYCLE_DOC_PATH} from "../../plan/github.ts";
import {DECISIONS_ROOT} from "../../review/classes.ts";
import {ROADMAP_FILE} from "../../triage/roadmap.ts";
import {loadConfig, resolve} from "../load.ts";
import {
	CYCLE_DOC_KEY,
	cycleDocKey,
	DECISIONS_DIR,
	decisionsDirKey,
	ROADMAP_FILE_KEY,
	roadmapFileKey,
	SHIPPED_CYCLE_DOC,
	SHIPPED_DECISIONS_DIR,
	SHIPPED_ROADMAP_FILE,
} from "./paths.ts";

const load = (config: Record<string, unknown>) =>
	loadConfig({_tag: "Text", text: JSON.stringify(config)});

describe("a repo that declares nothing gets the shipped paths", () => {
	it("resolves every path key to its shipped value with no config file at all", () => {
		const absent = loadConfig({_tag: "Absent"});
		expect(resolve(absent, decisionsDirKey)).toMatchObject({
			_tag: "Default",
			value: {_tag: "Path", path: SHIPPED_DECISIONS_DIR},
		});
		for (const [key, shipped] of [
			[roadmapFileKey, SHIPPED_ROADMAP_FILE],
			[cycleDocKey, SHIPPED_CYCLE_DOC],
		] as const) {
			expect(resolve(absent, key)).toMatchObject({_tag: "Default", value: shipped});
		}
	});

	// The shipped values and the sites that used to spell them out are one string each, so a rename
	// cannot land in only one place. Each of these is a re-export of this module's constant.
	it("is the same string each reading site names", () => {
		expect(DECISIONS_ROOT).toBe(`${SHIPPED_DECISIONS_DIR}/`);
		expect(ROADMAP_FILE).toBe(SHIPPED_ROADMAP_FILE);
		expect(CYCLE_DOC_PATH).toBe(SHIPPED_CYCLE_DOC);
	});

	it("keeps today's values, so an existing repo sees no change", () => {
		expect(SHIPPED_DECISIONS_DIR).toBe(".decisions");
		expect(SHIPPED_ROADMAP_FILE).toBe("ROADMAP.md");
		expect(SHIPPED_CYCLE_DOC).toBe("product-development-cycle.md");
	});
});

describe("a declared path", () => {
	it("takes the repo's value, trimmed", () => {
		expect(resolve(load({[ROADMAP_FILE_KEY]: "  docs/roadmap.md "}), roadmapFileKey)).toMatchObject(
			{_tag: "Declared", layer: "tracked", value: "docs/roadmap.md"},
		);
		expect(resolve(load({[CYCLE_DOC_KEY]: "docs/cycle.md"}), cycleDocKey)).toMatchObject({
			_tag: "Declared",
			layer: "tracked",
			value: "docs/cycle.md",
		});
	});

	it("refuses a value that is not a repo-relative path, rather than resolving it", () => {
		for (const bad of ["", "   ", "/etc/passwd", "../elsewhere/ROADMAP.md", 7, [], null]) {
			expect(resolve(load({[ROADMAP_FILE_KEY]: bad}), roadmapFileKey)._tag).toBe("Malformed");
		}
	});
});

describe("`decisionsDir` is the one declinable key", () => {
	it("reads null as a repo that keeps no decision corpus", () => {
		expect(resolve(load({[DECISIONS_DIR]: null}), decisionsDirKey)).toMatchObject({
			_tag: "Declared",
			layer: "tracked",
			value: {_tag: "Declined"},
		});
	});

	it("keeps declining apart from an absent key, which is the shipped corpus", () => {
		expect(resolve(load({}), decisionsDirKey)).toMatchObject({
			_tag: "Default",
			value: {_tag: "Path", path: SHIPPED_DECISIONS_DIR},
		});
	});

	it("names `null` in its refusal, so a repo that meant to decline knows how", () => {
		const resolved = resolve(load({[DECISIONS_DIR]: ""}), decisionsDirKey);
		expect(resolved._tag).toBe("Malformed");
		if (resolved._tag !== "Malformed") return;
		expect(resolved.reason).toContain("null");
	});

	it("renders a declined key back as `null` — the readout prints what the file says", () => {
		expect(decisionsDirKey.render?.({_tag: "Declined"})).toBeNull();
		expect(decisionsDirKey.render?.({_tag: "Path", path: ".decisions"})).toBe(".decisions");
	});
});
