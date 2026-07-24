/**
 * The ADR 0134 non-TTY posture, as a pure decision — no real terminal. Load-bearing contract:
 * a non-interactive caller (agent/CI) ALWAYS proceeds without a prompt (the action is logged),
 * and an interactive human proceeds only on an affirmative answer. Mirrors the flag lever's
 * `decideLeverGuard` unit tests (`flagship-core.ts`).
 */
import {assert, describe, it} from "@effect/vitest";
import {decideConfirm} from "./posture.ts";

describe("decideConfirm — the non-TTY posture (ADR 0134)", () => {
	it("a non-TTY caller proceeds without a prompt (interactive: false)", () => {
		const decision = decideConfirm({isTTY: false, confirmResponse: undefined});
		assert.strictEqual(decision._tag, "Proceed");
		assert.strictEqual(decision._tag === "Proceed" ? decision.interactive : null, false);
	});

	it("a non-TTY caller proceeds even if some stray response is present", () => {
		const decision = decideConfirm({isTTY: false, confirmResponse: "n"});
		assert.strictEqual(decision._tag, "Proceed");
	});

	for (const answer of ["y", "Y", "yes", "YES", " yes "]) {
		it(`an interactive "${answer}" proceeds (interactive: true)`, () => {
			const decision = decideConfirm({isTTY: true, confirmResponse: answer});
			assert.strictEqual(decision._tag, "Proceed");
			assert.strictEqual(decision._tag === "Proceed" ? decision.interactive : null, true);
		});
	}

	for (const answer of ["n", "no", "", "maybe", undefined] as const) {
		it(`an interactive ${JSON.stringify(answer)} refuses`, () => {
			const decision = decideConfirm({isTTY: true, confirmResponse: answer});
			assert.strictEqual(decision._tag, "Refuse");
		});
	}
});
