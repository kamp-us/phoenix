import {describe, expect, it} from "vitest";
import {getExhibit, listExhibits} from "./registry";

describe("exhibit registry — headless enumeration", () => {
	it("enumerates registered exhibits without rendering", () => {
		const exhibits = listExhibits();
		expect(exhibits.length).toBeGreaterThan(0);
		expect(exhibits.map((e) => e.id)).toContain("button");
	});

	it("registers the Button exhibit with a component and a knob schema", () => {
		const button = getExhibit("button");
		expect(button).toBeDefined();
		expect(button?.title).toBe("Button");
		expect(button?.component).toBeTruthy();
		expect(Object.keys(button?.knobs ?? {})).toContain("variant");
	});

	it("registers the local Pi Agent Chat Input prototype", () => {
		const agentChatInput = getExhibit("agent-chat-input");
		expect(agentChatInput?.title).toBe("Agent Chat Input");
		expect(agentChatInput?.component).toBeTruthy();
		expect(Object.keys(agentChatInput?.knobs ?? {})).toEqual(
			expect.arrayContaining(["initialValue", "disabled"]),
		);
	});

	it("registers the command palette with its search-state knobs", () => {
		const palette = getExhibit("command-palette");
		expect(palette?.title).toBe("Command Palette");
		expect(palette?.component).toBeTruthy();
		expect(Object.keys(palette?.knobs ?? {})).toEqual(
			expect.arrayContaining(["defaultQuery", "loading", "disabled", "maxResults"]),
		);
	});

	it("resolves by id and returns undefined for an unknown slug", () => {
		expect(getExhibit("button")?.id).toBe("button");
		expect(getExhibit("does-not-exist")).toBeUndefined();
	});

	it("holds unique ids (no two exhibits share a slug)", () => {
		const ids = listExhibits().map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("leads the catalog with the composer feature exhibit", () => {
		const exhibits = listExhibits();
		expect(exhibits[0]?.id).toBe("composer");
		const composer = getExhibit("composer");
		expect(composer?.title).toBe("Composer");
		expect(composer?.component).toBeTruthy();
		expect(Object.keys(composer?.knobs ?? {})).toContain("readOnly");
	});

	// The catalog (#3094) covers every UI primitive under @kampus/design. This pins the
	// contract so a newly-added primitive without an exhibit surfaces as a red test.
	it("catalogs an exhibit for every UI primitive", () => {
		const ids = new Set(listExhibits().map((e) => e.id));
		const expected = [
			"avatar",
			"button",
			"card",
			"collapsible",
			"command-palette",
			"copy-link-button",
			"count-toggle",
			"dialog",
			"draft-restore-banner",
			"edited-indicator",
			"empty-state",
			"form",
			"menu",
			"meta-row",
			"report-button",
			"review-badge",
			"switch",
			"tabs",
			"toast",
			"toggle-group",
			"tooltip",
		];
		for (const id of expected) {
			expect(ids).toContain(id);
		}
	});
});
