import {describe, expect, it} from "vitest";
import {renderFooter} from "../report/compose.ts";
import {
	hasAgentFooter,
	OPERATOR_ACCOUNTS_ENV,
	provenanceOf,
	resolveOperatorAccounts,
} from "./provenance.ts";

/** A placeholder operator set — the mechanism is what is under test, never a real login. */
const OPERATORS = resolveOperatorAccounts({[OPERATOR_ACCOUNTS_ENV]: "operator-account"});
const NONE: ReadonlySet<string> = new Set();

const footer = (extra: Partial<Parameters<typeof renderFooter>[0]> = {}) =>
	renderFooter({
		session: null,
		model: null,
		branch: null,
		timestamp: "2026-08-03T18:00:00Z",
		...extra,
	});

describe("hasAgentFooter", () => {
	it("matches the footer the emitter really produces, sparse or full", () => {
		expect(hasAgentFooter(`## Summary\n\nsomething\n\n${footer()}`)).toBe(true);
		expect(
			hasAgentFooter(`body\n\n${footer({session: "abc", model: "opus", branch: "usirin/x"})}`),
		).toBe(true);
	});

	it("matches across CRLF line endings", () => {
		expect(hasAgentFooter(`body\r\n\r\n${footer().replace(/\n/g, "\r\n")}`)).toBe(true);
	});

	it("answers human on a body that merely QUOTES the phrase — the anchor is the point", () => {
		expect(
			hasAgentFooter("The footer reads `<sub>Filed by an agent · …</sub>` and is wrong."),
		).toBe(false);
		expect(hasAgentFooter("A discussion of ADR 0159: Filed by an agent is the signal.")).toBe(
			false,
		);
		expect(hasAgentFooter("> <sub>Filed by an agent · 2026-01-01</sub>")).toBe(false);
	});

	it("answers human on a hand-typed body that never mentions the footer at all", () => {
		expect(hasAgentFooter("I hit a bug in the retry helper.\n")).toBe(false);
	});

	it("answers human on an empty body from a non-operator — the fail-closed default", () => {
		expect(provenanceOf({body: "", author: "someone-else"}, OPERATORS)).toBe("human");
	});

	it("answers agent on the footer alone", () => {
		expect(provenanceOf({body: footer(), author: "someone-else"}, OPERATORS)).toBe("agent");
	});
});

describe("resolveOperatorAccounts", () => {
	it("reads a comma- or whitespace-separated list, tolerating @ and case", () => {
		const set = resolveOperatorAccounts({[OPERATOR_ACCOUNTS_ENV]: " @One, two\tTHREE "});
		expect([...set].sort()).toEqual(["one", "three", "two"]);
	});

	it("yields the EMPTY set when unset or blank — the footer-only rule, never a wider one", () => {
		expect(resolveOperatorAccounts({}).size).toBe(0);
		expect(resolveOperatorAccounts({[OPERATOR_ACCOUNTS_ENV]: "  ,  "}).size).toBe(0);
	});
});

describe("provenanceOf — the operator-account signal (#4619 ruling)", () => {
	it("answers agent for a FOOTERLESS filing authored by an operator account", () => {
		expect(
			provenanceOf({body: "quick note, no footer\n", author: "operator-account"}, OPERATORS),
		).toBe("agent");
	});

	it("still answers human for a footerless filing from any OTHER author", () => {
		expect(provenanceOf({body: "quick note, no footer\n", author: "cansirin"}, OPERATORS)).toBe(
			"human",
		);
	});

	it("matches the operator login case-insensitively and past a leading @", () => {
		expect(provenanceOf({body: "no footer\n", author: "@Operator-Account"}, OPERATORS)).toBe(
			"agent",
		);
	});

	it("falls back to the footer-only rule when no operator set is configured", () => {
		expect(provenanceOf({body: "no footer\n", author: "operator-account"}, NONE)).toBe("human");
		expect(provenanceOf({body: footer(), author: "operator-account"}, NONE)).toBe("agent");
	});

	it("never treats an unreadable (empty) author as an operator", () => {
		expect(provenanceOf({body: "no footer\n", author: ""}, OPERATORS)).toBe("human");
	});
});
