import {describe, expect, it} from "vitest";
import {read as readMarker} from "../wire/verdict-marker.ts";
import {archived, compose, FENCE, heading, split} from "./supersede.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const FAIL = `review-doc: FAIL @ ${HEAD} — the round-1 blocker\n\none change asked for.\n`;
const PASS = `review-doc: PASS @ ${HEAD} — merge-ready\n\nthe correction landed.\n`;
const DAY = new Date("2026-08-29T05:11:17Z");

describe("compose", () => {
	it("puts the fresh verdict first, so a marker reader resolves the newest one", () => {
		const body = compose(FAIL, PASS, DAY);
		const marker = readMarker(body);
		expect(marker._tag).toBe("Found");
		expect(marker._tag === "Found" && marker.value.polarity).toBe("PASS");
	});

	it("keeps the prior verdict's text verbatim under a dated heading", () => {
		const body = compose(FAIL, PASS, DAY);
		expect(body).toContain(heading(DAY));
		expect(body).toContain(FAIL.trimEnd());
	});

	it("carries an existing archive through instead of nesting a second envelope", () => {
		const once = compose(FAIL, PASS, DAY);
		const twice = compose(once, FAIL, DAY);
		expect(twice.match(new RegExp(FENCE, "g"))).toHaveLength(1);
		expect(twice.match(/## Superseded verdict/g)).toHaveLength(2);
		expect(twice).toContain("the round-1 blocker");
		expect(twice).toContain("merge-ready");
	});
});

describe("split", () => {
	it("reads a comment carrying no fence as all live", () => {
		expect(split(PASS)).toEqual({live: PASS, archive: ""});
	});

	it("cuts the live verdict off at the fence", () => {
		const {live, archive} = split(compose(FAIL, PASS, DAY));
		expect(live).toContain("merge-ready");
		expect(live).not.toContain("round-1 blocker");
		expect(archive).toContain("round-1 blocker");
	});
});

describe("archived", () => {
	it("hands back each retired verdict opening on its own marker line, newest first", () => {
		const rows = archived(compose(compose(FAIL, PASS, DAY), FAIL, DAY));
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => readMarker(row)).map((read) => read._tag)).toEqual(["Found", "Found"]);
		expect(rows[0]).toContain("merge-ready");
		expect(rows[1]).toContain("round-1 blocker");
	});

	it("is empty for a comment that never superseded anything", () => {
		expect(archived(PASS)).toEqual([]);
	});
});
