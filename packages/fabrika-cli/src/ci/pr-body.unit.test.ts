import {describe, expect, it} from "vitest";
import {sanitizeReleaseBody} from "./pr-body.ts";

/** The shape release-please writes for a manifest Release PR, trimmed to the parts that matter. */
const bodyWith = (changelogLine: string): string =>
	[
		":robot: I have created a release *beep* *boop*",
		"---",
		"",
		"<details><summary>fabrika-cli: 0.3.0</summary>",
		"",
		"### Bug Fixes",
		"",
		changelogLine,
		"</details>",
		"",
		"---",
	].join("\n");

describe("sanitizeReleaseBody", () => {
	it("leaves a body with no stray tag untouched", () => {
		const body = bodyWith("* **lane:** key a lane by chore name ([#5846](https://x/5846))");
		expect(sanitizeReleaseBody(body)).toEqual({body, stripped: []});
	});

	// The #5946 body verbatim in shape: commit d8d23de1's subject carried a literal `<details>`,
	// which gave the parser a second `<details>` element with no `<summary>` inside it.
	it("strips the brackets off a stray tag a commit subject carried in", () => {
		const repair = sanitizeReleaseBody(
			bodyWith("* **wire:** read criteria outside a `<details>` appendix ([d8d23de](https://x))"),
		);
		expect(repair.stripped).toEqual(["<details>"]);
		expect(repair.body).toContain("outside a `details` appendix");
		expect(repair.body).not.toContain("`<details>`");
	});

	it("preserves the two lines release-please writes as structure", () => {
		const repair = sanitizeReleaseBody(
			bodyWith("* **wire:** read criteria outside a `<details>` appendix"),
		);
		expect(repair.body).toContain("<details><summary>fabrika-cli: 0.3.0</summary>");
		expect(repair.body.split("\n")).toContain("</details>");
	});

	it("strips a closing tag and a tag with attributes too", () => {
		const repair = sanitizeReleaseBody(bodyWith("* **ui:** drop </summary> and <img src=x> alike"));
		expect(repair.stripped).toEqual(["</summary>", "<img src=x>"]);
		expect(repair.body).toContain("drop summary and img src=x alike");
	});

	it("leaves an angle bracket no parser opens a tag on alone", () => {
		const body = bodyWith("* **guard:** fail when depth < 3 and count > 0");
		expect(sanitizeReleaseBody(body)).toEqual({body, stripped: []});
	});

	// A repaired body must not need repairing again, or the workflow would write on every run.
	it("is idempotent", () => {
		const once = sanitizeReleaseBody(
			bodyWith("* **wire:** read criteria outside a `<details>` appendix"),
		);
		expect(sanitizeReleaseBody(once.body)).toEqual({body: once.body, stripped: []});
	});

	it("does not preserve a summary-less line that only looks structural", () => {
		const repair = sanitizeReleaseBody(bodyWith("* **wire:** open a bare <details> here"));
		expect(repair.stripped).toEqual(["<details>"]);
	});
});
