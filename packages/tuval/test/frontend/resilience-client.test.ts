import {describe, expect, it} from "vitest";
import {decodeRestorationSnapshot} from "../../src/frontend-shell/resilience-client.js";

const snapshot = {
	stages: [
		{stage: "discovery", status: "restored"},
		{stage: "lineage", status: "degraded"},
		{stage: "selection", status: "restored"},
		{stage: "settings", status: "restored"},
		{stage: "package-registrations", status: "restored"},
		{stage: "extension-ui-current", status: "restored"},
	],
	selectedSessionId: "child-session",
	settings: {density: "compact", nodeDetailLevel: "full", theme: "dark"},
	packageRegistrations: ["fixture-package"],
	extensionUI: [
		{
			scope: {packageName: "fixture-package", sessionId: "child-session"},
			statuses: [{key: "state", text: "ready"}],
			widgets: [{key: "context", lines: ["healthy"], placement: "aboveEditor"}],
		},
	],
	diagnostics: [
		{
			category: "lineage",
			code: "lineage-restore-failed",
			message: "A retained source could not be joined",
			action: "Inspect the retained lineage source",
			sourceId: "run:broken",
		},
	],
} as const;

describe("decodeRestorationSnapshot", () => {
	it("accepts the hardened restoration and diagnostic contract", () => {
		expect(decodeRestorationSnapshot(snapshot)).toEqual(snapshot);
	});

	it("retains every healthy component when selection and one extension snapshot are corrupt", () => {
		const decoded = decodeRestorationSnapshot({
			...snapshot,
			selectedSessionId: 42,
			extensionUI: [...snapshot.extensionUI, {scope: {packageName: "broken"}, statuses: []}],
		});
		expect(decoded).toMatchObject({
			selectedSessionId: null,
			settings: snapshot.settings,
			packageRegistrations: snapshot.packageRegistrations,
			extensionUI: snapshot.extensionUI,
		});
		expect(decoded?.stages).toEqual(snapshot.stages);
		expect(decoded?.diagnostics.map(({code}) => code)).toEqual(
			expect.arrayContaining([
				"lineage-restore-failed",
				"selected-session-state-invalid",
				"extension-ui-current-invalid",
			]),
		);
	});

	it("redacts malformed diagnostic content while preserving valid stages and settings", () => {
		const decoded = decodeRestorationSnapshot({
			...snapshot,
			diagnostics: [
				snapshot.diagnostics[0],
				{...snapshot.diagnostics[0], message: {prompt: "secret"}},
			],
		});
		expect(decoded?.settings).toEqual(snapshot.settings);
		expect(decoded?.stages).toEqual(snapshot.stages);
		expect(JSON.stringify(decoded)).not.toContain("secret");
		expect(decoded?.diagnostics.map(({code}) => code)).toContain("workspace-state-unavailable");
	});

	it("refuses only a non-object envelope", () => {
		expect(decodeRestorationSnapshot(null)).toBeUndefined();
		expect(decodeRestorationSnapshot("invalid")).toBeUndefined();
	});
});
