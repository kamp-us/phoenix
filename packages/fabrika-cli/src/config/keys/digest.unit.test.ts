import {describe, expect, it} from "vitest";
import {loadConfig, resolve} from "../load.ts";
import {DIGEST, digestKey, SHIPPED_DIGEST} from "./digest.ts";

const declared = (digest: unknown) =>
	resolve(loadConfig({_tag: "Text", text: JSON.stringify({[DIGEST]: digest})}), digestKey);

const refusal = (digest: unknown): string => {
	const resolved = declared(digest);
	return resolved._tag === "Malformed" ? resolved.reason : `resolved ${resolved._tag}`;
};

describe("a repo with no `digest` block", () => {
	it("has the report off", () => {
		expect(resolve(loadConfig({_tag: "Absent"}), digestKey)).toMatchObject({
			_tag: "Default",
			value: {_tag: "Off"},
		});
		expect(
			resolve(loadConfig({_tag: "Text", text: JSON.stringify({table: {}})}), digestKey),
		).toMatchObject({_tag: "Default", value: {_tag: "Off"}});
	});
});

describe("a declared `digest` block", () => {
	it("takes the shipped value for every sub-key but the tool", () => {
		expect(declared({tool: "slack"})).toEqual({
			_tag: "Declared",
			layer: "tracked",
			value: {_tag: "On", tool: "slack", ...SHIPPED_DIGEST},
		});
		expect(SHIPPED_DIGEST).toEqual({
			webhookEnv: "FABRIKA_DIGEST_WEBHOOK",
			sections: ["triage", "on-call"],
			triageTargetHours: 24,
			allClear: false,
		});
	});

	it("takes each sub-key the repo wrote", () => {
		expect(
			declared({
				tool: "discord",
				webhookEnv: "TEAM_CHANNEL_HOOK",
				sections: ["on-call"],
				triageTargetHours: 8,
				allClear: true,
			}),
		).toMatchObject({
			_tag: "Declared",
			value: {
				_tag: "On",
				tool: "discord",
				webhookEnv: "TEAM_CHANNEL_HOOK",
				sections: ["on-call"],
				triageTargetHours: 8,
				allClear: true,
			},
		});
	});

	it("refuses a chat tool it does not post to, naming the key", () => {
		expect(refusal({tool: "teams"})).toBe(
			"`digest.tool` is not a chat tool — one of slack, discord",
		);
		expect(refusal({})).toContain("`digest.tool`");
	});

	it("refuses a section it does not build, naming the entry", () => {
		expect(refusal({tool: "slack", sections: ["triage", "parked-lanes"]})).toBe(
			"`digest.sections[1]` is not a section — one of triage, on-call",
		);
		expect(refusal({tool: "slack", sections: ["triage", "triage"]})).toContain(
			'`digest.sections` names "triage" twice',
		);
		expect(refusal({tool: "slack", sections: []})).toContain("`digest.sections` names no section");
	});

	it("refuses a webhook URL where the variable name goes, without echoing it", () => {
		const url = "https://hooks.slack.com/services/T000/B000/secret-token";
		const reason = refusal({tool: "slack", webhookEnv: url});

		expect(reason).toContain("`digest.webhookEnv` is not an environment variable name");
		expect(reason).not.toContain("hooks.slack.com");
		expect(reason).not.toContain("secret-token");
	});

	it("refuses a setting it does not have, a target that is no wait, and a non-boolean all-clear", () => {
		expect(refusal({tool: "slack", webhook: "X"})).toContain("`digest.webhook` is not a setting");
		expect(refusal({tool: "slack", triageTargetHours: 0})).toContain(
			"`digest.triageTargetHours` is not a positive number of hours",
		);
		expect(refusal({tool: "slack", allClear: "yes"})).toContain(
			"`digest.allClear` is not true or false",
		);
		expect(refusal(["slack"])).toBe("`digest` is not an object");
	});
});
