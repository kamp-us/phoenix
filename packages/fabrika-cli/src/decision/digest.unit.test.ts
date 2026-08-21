import {describe, expect, it} from "vitest";
import {bodyDigest, DIGEST_RE} from "./digest.ts";

const BODY = "## The decision\n\nWhich fork?\n\n- [ ] an ADR records the choice\n";

describe("bodyDigest", () => {
	it("emits the width the wire marker brands", () => {
		expect(bodyDigest(BODY)).toMatch(DIGEST_RE);
	});

	it("moves on any edit a person could mean by rewriting the issue", () => {
		const edits = [
			BODY.replace("Which fork?", "Which of the three forks?"),
			`${BODY}\n## Amendment\n\nRe-scoped.\n`,
			BODY.replace("- [ ] an ADR records the choice", "- [ ] an ADR records both choices"),
		];
		for (const edited of edits) expect(bodyDigest(edited)).not.toBe(bodyDigest(BODY));
	});

	/**
	 * The canonicalization's whole purpose: GitHub's own clients round-trip a body through CRLF, so a
	 * digest sensitive to that would read a founder's ruling as stale because somebody opened the
	 * issue in a different editor.
	 */
	it("does not move on line endings or trailing whitespace alone", () => {
		expect(bodyDigest(BODY.replace(/\n/g, "\r\n"))).toBe(bodyDigest(BODY));
		expect(bodyDigest(BODY.replace(/\n/g, "   \n"))).toBe(bodyDigest(BODY));
		expect(bodyDigest(`\n\n${BODY}\n\n`)).toBe(bodyDigest(BODY));
	});

	it("distinguishes an empty body from a body with content in it", () => {
		expect(bodyDigest("")).not.toBe(bodyDigest(BODY));
		expect(bodyDigest("")).toMatch(DIGEST_RE);
	});
});
