import {describe, expect, it} from "vitest";
import {signoffAt} from "./owner-signoff.ts";

const OWNER = "owner";
const ROSTER = new Set([OWNER]);
const HEAD = "a".repeat(40);
const MARKER = `owner-action-signoff @ ${HEAD}`;
const STAMP = "\n\n<sub>Filed by an agent · session 3fa85f64-5717-4562-b3fc-2c963f66afa6</sub>";

describe("signoffAt — an agent-stamped comment is not an owner's sign-off", () => {
	it("is Unsigned on a roster account's stamped sign-off at the live head, saying why", () => {
		const read = signoffAt([{author: OWNER, body: `${MARKER}${STAMP}`}], ROSTER, HEAD);

		expect(read._tag).toBe("Unsigned");
		expect(read._tag === "Unsigned" && read.reason).toMatch(
			/stamped comment is not an owner's sign-off/,
		);
	});

	it("is Signed on the same marker by the same account with no stamp", () => {
		expect(signoffAt([{author: OWNER, body: MARKER}], ROSTER, HEAD)).toEqual({
			_tag: "Signed",
			login: OWNER,
			sha: HEAD,
		});
	});

	it.each([
		["the stamped one comes first", [`${MARKER}${STAMP}`, MARKER]],
		["the stamped one comes last", [MARKER, `${MARKER}${STAMP}`]],
	] as const)("is Signed on the unstamped sign-off when both stand at the head and %s", (_name, bodies) => {
		const read = signoffAt(
			bodies.map((body) => ({author: OWNER, body})),
			ROSTER,
			HEAD,
		);

		expect(read).toEqual({_tag: "Signed", login: OWNER, sha: HEAD});
	});
});
