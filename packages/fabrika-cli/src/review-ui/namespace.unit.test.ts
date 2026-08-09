/**
 * The `review-ui` namespace against the registered `verdict-marker` wire format.
 *
 * The implementation ticket flagged "one registry-side enum addition" as owed. It is not: the
 * format gates the namespace with a **pattern**, `^(review|check-epic-plan|governance)(-[a-z0-9]+)*$`, not a
 * closed vocabulary, and `review-ui` already satisfies it. This test is that finding held in place —
 * a future narrowing of the pattern reds here rather than silently making this group's every
 * verdict unreadable.
 */
import {assert, describe, it} from "@effect/vitest";
import {clause, emit, headSha, read} from "../wire/verdict-marker.ts";
import {NAMESPACE} from "./post-verb.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";

describe("the review-ui namespace", () => {
	it("round-trips through the shipped format with no registry change", () => {
		const line = emit({
			namespace: NAMESPACE,
			polarity: "FAIL",
			sha: headSha(HEAD) as never,
			clause: clause("changes-requested") as never,
		});
		const parsed = read(line);
		assert.strictEqual(parsed._tag, "Found");
		assert.strictEqual(parsed._tag === "Found" ? parsed.value.namespace : "", "review-ui");
	});
});
