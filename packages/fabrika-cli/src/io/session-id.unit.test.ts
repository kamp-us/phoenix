import {describe, expect, it} from "vitest";
import {SESSION_ID_VARS, sessionIdFrom, sessionIdUnset} from "./session-id.ts";

describe("sessionIdFrom", () => {
	it("prefers FABRIKA_SESSION_ID over CLAUDE_CODE_SESSION_ID", () => {
		expect(sessionIdFrom({FABRIKA_SESSION_ID: "explicit", CLAUDE_CODE_SESSION_ID: "cc"})).toBe(
			"explicit",
		);
	});

	it("prefers CLAUDE_CODE_SESSION_ID over PI_SUBAGENT_PARENT_SESSION", () => {
		expect(sessionIdFrom({CLAUDE_CODE_SESSION_ID: "cc", PI_SUBAGENT_PARENT_SESSION: "pi"})).toBe(
			"cc",
		);
	});

	it("falls back to PI_SUBAGENT_PARENT_SESSION alone — pi works out of the box (#6960)", () => {
		expect(sessionIdFrom({PI_SUBAGENT_PARENT_SESSION: "pi"})).toBe("pi");
	});

	it("falls back to CLAUDE_CODE_SESSION_ID alone", () => {
		expect(sessionIdFrom({CLAUDE_CODE_SESSION_ID: "cc"})).toBe("cc");
	});

	it("takes FABRIKA_SESSION_ID when it is the only one set", () => {
		expect(sessionIdFrom({FABRIKA_SESSION_ID: "explicit"})).toBe("explicit");
	});

	it("treats a blank value as unset and falls through to the next variable", () => {
		expect(sessionIdFrom({FABRIKA_SESSION_ID: "   ", PI_SUBAGENT_PARENT_SESSION: "pi"})).toBe("pi");
	});

	it("trims the value it resolves", () => {
		expect(sessionIdFrom({CLAUDE_CODE_SESSION_ID: "  cc  "})).toBe("cc");
	});

	it("resolves null when all supported variables are unset or blank — fail-closed stays", () => {
		expect(sessionIdFrom({})).toBeNull();
		expect(
			sessionIdFrom({
				FABRIKA_SESSION_ID: "",
				CLAUDE_CODE_SESSION_ID: undefined,
				PI_SUBAGENT_PARENT_SESSION: "\t ",
			}),
		).toBeNull();
	});

	it("names all supported consulted variables in the unset refusal clause", () => {
		for (const name of SESSION_ID_VARS) expect(sessionIdUnset).toContain(name);
	});
});

for (const name of ["CODEX_THREAD_ID", "CODEX_SESSION_ID"]) {
	it(`recognizes ${name} while preserving existing harness precedence`, () => {
		expect(sessionIdFrom({[name]: "codex"})).toBe("codex");
		expect(sessionIdFrom({[name]: "codex", PI_SUBAGENT_PARENT_SESSION: "pi"})).toBe("pi");
		expect(sessionIdFrom({[name]: "codex", FABRIKA_SESSION_ID: "override"})).toBe("override");
	});
}
it("falls through blank Codex identities and prefers the thread identity", () => {
	expect(sessionIdFrom({CODEX_THREAD_ID: "thread", CODEX_SESSION_ID: "session"})).toBe("thread");
	expect(sessionIdFrom({CODEX_THREAD_ID: " ", CODEX_SESSION_ID: "session"})).toBe("session");
	expect(sessionIdFrom({CODEX_THREAD_ID: " ", CODEX_SESSION_ID: " "})).toBeNull();
});
