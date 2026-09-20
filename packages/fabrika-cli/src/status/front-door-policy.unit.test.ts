import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {parse} from "yaml";
import {skillFrom} from "./roster.ts";

const skill = new URL("../../../../claude-plugins/fabrika/skills/front-door/", import.meta.url);

describe("front-door invocation policy", () => {
	it("keeps the roster's human-only axis and Codex's implicit policy consistent", () => {
		const row = skillFrom("front-door", readFileSync(new URL("SKILL.md", skill), "utf8"));
		const metadata = parse(readFileSync(new URL("agents/openai.yaml", skill), "utf8"));
		expect(row.frontmatterReadable).toBe(true);
		expect(row.invocationAxis).toBe("user");
		expect(metadata.policy.allow_implicit_invocation).toBe(false);
		expect(metadata.interface.short_description).toBeTruthy();
	});
});
