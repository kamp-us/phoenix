import {describe, expect, it} from "vitest";
import {compose as supersedeWith} from "../review/supersede.ts";
import {emit, read} from "./evidence-gallery.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";
const A = {
	title: "/pano @ desktop",
	url: "https://github.com/user-attachments/assets/a",
	sha256: "a".repeat(64),
};
const B = {
	title: "/pano @ mobile",
	url: "https://github.com/user-attachments/assets/b",
	sha256: "b".repeat(64),
};

const verdict = (polarity: string, shots = [A, B]) =>
	`review-ui: ${polarity} @ ${HEAD} — the clause\n\n| surface | verdict |\n\n${emit(shots)}\n`;

describe("the evidence gallery", () => {
	it("reads back every shot it emitted, with its digest", () => {
		expect(read(verdict("PASS"))).toEqual({
			_tag: "Found",
			evidence: [
				{url: A.url, sha256: A.sha256},
				{url: B.url, sha256: B.sha256},
			],
		});
	});

	it("reads only the verdict in force, never a superseded one's gallery below the fence", () => {
		const body = supersedeWith(verdict("FAIL", [A]), verdict("PASS", [B]), new Date(0));
		expect(read(body)).toEqual({_tag: "Found", evidence: [{url: B.url, sha256: B.sha256}]});
	});

	it("is unprovable when an image carries no digest line", () => {
		const legacy = `review-ui: PASS @ ${HEAD} — ok\n\n## Evidence\n\n### /pano\n\n![/pano](${A.url})\n`;
		const got = read(legacy);
		expect(got._tag).toBe("Unprovable");
		expect(got._tag === "Unprovable" ? got.reason : "").toMatch(/carries no sha256 line/);
	});

	it("is unprovable with no gallery, or a gallery with no hosted capture", () => {
		expect(read(`review-ui: PASS @ ${HEAD} — ok\n`)._tag).toBe("Unprovable");
		expect(read(`review-ui: PASS @ ${HEAD} — ok\n\n## Evidence\n`)._tag).toBe("Unprovable");
	});
});
