/**
 * Sozluk definition-validation unit coverage (ADR 0082) — the definition input
 * checks + the title-from-slug derivation that are wrong-or-right with NO
 * database.
 *
 * `addDefinition` / `editDefinition` run `validateBody` BEFORE any DB read, and
 * `addDefinition` derives a fallback term title from the slug — both pure logic
 * on the input, which could never be wrong just because the database differed
 * (ADR 0082 litmus). Both are now exported module-level functions with no
 * `Drizzle` dependency, so calling them directly is the "no DB read" proof. The
 * DB-state-dependent rejections of the same mutations (`DEFINITION_NOT_FOUND`,
 * `UNAUTHORIZED`) stay on real D1 in `tests/integration/sozluk-mutations.test.ts`.
 */

import {Cause, Effect, Exit} from "effect";
import {assert, describe, expect, it} from "vitest";
import {DEFINITION_BODY_MAX, titleFromSlug, validateBody} from "./Sozluk.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSyncExit(effect);

const expectTag = (exit: Exit.Exit<unknown, unknown>, tag: string) => {
	assert.isTrue(Exit.isFailure(exit), "expected validateBody to fail");
	if (Exit.isFailure(exit)) {
		const error = Cause.findErrorOption(exit.cause);
		assert.isTrue(error._tag === "Some", "expected a typed failure, not a die");
		if (error._tag === "Some") {
			assert.strictEqual((error.value as {_tag: string})._tag, tag);
		}
	}
};

const expectValue = <A>(exit: Exit.Exit<A, unknown>): A => {
	assert.isTrue(Exit.isSuccess(exit), "expected validateBody to succeed");
	if (Exit.isSuccess(exit)) return exit.value;
	throw new Error("unreachable");
};

describe("Sozluk.validateBody", () => {
	it("an undefined body rejects with BodyRequired", () => {
		expectTag(run(validateBody(undefined)), "sozluk/BodyRequired");
	});

	it("a whitespace-only body rejects with BodyRequired", () => {
		expectTag(run(validateBody("   ")), "sozluk/BodyRequired");
	});

	it("a body over the max rejects with BodyTooLong", () => {
		expectTag(run(validateBody("a".repeat(DEFINITION_BODY_MAX + 1))), "sozluk/BodyTooLong");
	});

	it("a valid body returns verbatim (untrimmed)", () => {
		expect(expectValue(run(validateBody(" tanım ")))).toBe(" tanım ");
	});
});

describe("Sozluk.titleFromSlug", () => {
	it("replaces every dash with a space", () => {
		expect(titleFromSlug("pure-function")).toBe("pure function");
	});

	it("leaves a dash-free slug unchanged", () => {
		expect(titleFromSlug("fate")).toBe("fate");
	});

	it("handles consecutive dashes", () => {
		expect(titleFromSlug("a--b")).toBe("a  b");
	});
});
