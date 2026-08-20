import {describe, expect, it} from "vitest";
import {
	emit,
	markedIssue,
	parseFields,
	RULING_GRAMMAR,
	read,
	rules,
	rulingUrl,
	scopeDigest,
} from "./decision-ruling.ts";
import {markerTime} from "./grill-marker.ts";

const URL = "https://github.com/kamp-us/phoenix/issues/6569#issuecomment-3512345";
const MARKER = `decision-ruled: #6569 @ 4d90e1bb27ac · ruling:${URL} · 2026-08-20T05:11:02Z\n`;

const ruling = () => ({
	issue: markedIssue(6569) ?? (0 as never),
	digest: scopeDigest("4d90e1bb27ac") ?? ("" as never),
	ruling: rulingUrl(URL) ?? ("" as never),
	at: markerTime("2026-08-20T05:11:02Z") ?? ("" as never),
});

describe("read", () => {
	it("reads the marker a founder posts, and the bold form a skill writes", () => {
		expect(read(MARKER)).toMatchObject({
			_tag: "Found",
			value: {issue: 6569, digest: "4d90e1bb27ac", ruling: URL, at: "2026-08-20T05:11:02Z"},
		});
		expect(read(`**${MARKER.trim()}**\n`)).toMatchObject({_tag: "Found", value: {issue: 6569}});
	});

	it("answers Absent for a comment that carries no marker of this format", () => {
		expect(read("Ruled: take the second fork.\n")._tag).toBe("Absent");
	});

	it("answers Malformed, never Absent, for each field that can drift", () => {
		const drifts = [
			`decision-ruled: #6569 @ 4D90E1BB · ruling:${URL} · 2026-08-20T05:11:02Z\n`,
			"decision-ruled: #6569 @ 4d90e1bb27ac · 2026-08-20T05:11:02Z\n",
			`decision-ruled: 6569 @ 4d90e1bb27ac · ruling:${URL} · 2026-08-20T05:11:02Z\n`,
			`decision-ruled: #6569 @ 4d90e1bb27ac · ruling:${URL} · last Thursday\n`,
			"decision-ruled: #6569 @ 4d90e1bb27ac · ruling:not-a-url · 2026-08-20T05:11:02Z\n",
		];
		for (const artifact of drifts) expect(read(artifact)._tag).toBe("Malformed");
	});

	it("refuses a ruling recorded on another issue, however well-formed the URL", () => {
		const elsewhere =
			"decision-ruled: #6569 @ 4d90e1bb27ac · ruling:https://github.com/kamp-us/phoenix/issues/5842#issuecomment-3512345 · 2026-08-20T05:11:02Z\n";
		expect(read(elsewhere)._tag).toBe("Malformed");
	});
});

describe("emit", () => {
	it("round-trips through read", () => {
		expect(emit(ruling())).toBe(MARKER);
		expect(read(emit(ruling()))).toMatchObject({_tag: "Found", value: {ruling: URL}});
	});
});

describe("rules", () => {
	/**
	 * The staleness property the whole marker exists for: the digest is derived over the issue body,
	 * so a body rewritten under a standing ruling no longer matches it.
	 */
	it("stops rating a ruling current once the body it bound is rewritten", () => {
		expect(rules(ruling(), 6569, "4d90e1bb27ac")).toBe(true);
		expect(rules(ruling(), 6569, "0000aaaa1111")).toBe(false);
	});

	it("rules nothing on another issue, however fresh the digest", () => {
		expect(rules(ruling(), 5842, "4d90e1bb27ac")).toBe(false);
	});
});

describe("parseFields", () => {
	it("composes from `wire read`'s own output, in any order", () => {
		expect(
			parseFields(`at\t2026-08-20T05:11:02Z\nruling\t${URL}\ndigest\t4d90e1bb27ac\nissue\t#6569\n`),
		).toMatchObject({_tag: "Fields", ruling: {issue: 6569}});
	});

	it("refuses rather than defaults on every unusable field", () => {
		const unusable = [
			`digest: 4d90e1bb27ac\nruling: ${URL}\nat: 2026-08-20T05:11:02Z\n`,
			`issue: 6569\nruling: ${URL}\nat: 2026-08-20T05:11:02Z\n`,
			"issue: 6569\ndigest: 4d90e1bb27ac\nat: 2026-08-20T05:11:02Z\n",
			`issue: 6569\ndigest: 4d90e1bb27ac\nruling: ${URL}\n`,
			`issue: 6569\nissue: 5842\ndigest: 4d90e1bb27ac\nruling: ${URL}\nat: 2026-08-20T05:11:02Z\n`,
		];
		for (const fields of unusable) expect(parseFields(fields)._tag).toBe("Unusable");
	});

	it("names the grammar when the ruling is not an issue-comment URL", () => {
		const parsed = parseFields(
			"issue: 6569\ndigest: 4d90e1bb27ac\nruling: https://example.com\nat: 2026-08-20T05:11:02Z\n",
		);
		expect(parsed).toMatchObject({_tag: "Unusable"});
		expect(parsed._tag === "Unusable" && parsed.reason).toContain(RULING_GRAMMAR);
	});
});
