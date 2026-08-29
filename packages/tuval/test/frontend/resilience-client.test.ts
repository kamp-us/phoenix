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
	settings: {theme: "dark"},
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

	it.each([
		{...snapshot, selectedSessionId: 42},
		{...snapshot, packageRegistrations: ["healthy", 42]},
		{...snapshot, stages: [{stage: "unknown", status: "restored"}]},
		{...snapshot, diagnostics: [{...snapshot.diagnostics[0], message: {prompt: "secret"}}]},
	])("refuses an invalid independent source without guessing", (candidate) => {
		expect(decodeRestorationSnapshot(candidate)).toBeUndefined();
	});
});
