import {describe, expect, it} from "vitest";
import {renderFooter} from "../report/compose.ts";
import {hasAgentFooter, provenanceOf} from "./provenance.ts";

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

	it("answers human on an empty body — the fail-closed default", () => {
		expect(provenanceOf("")).toBe("human");
	});

	it("answers agent on the footer alone", () => {
		expect(provenanceOf(footer())).toBe("agent");
	});
});
