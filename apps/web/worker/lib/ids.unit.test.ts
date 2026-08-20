/**
 * Branded id pins. Assignability is encoded as a conditional-type boolean checked with
 * `expectTypeOf`, NOT `@ts-expect-error` — the effect LSP plugin's TS377003 escapes
 * those (the recurring finding in `domain-error-boundary.unit.test.ts`).
 */
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {VoteDefinitionInput} from "../features/sozluk/Sozluk.ts";
import {DefinitionId, type TermSlug, UserId} from "./ids.ts";

// `A extends B` as a checkable boolean — `true` iff an `A` is assignable to a `B`.
type Assignable<A, B> = [A] extends [B] ? true : false;

describe("branded ids — nominal distinctness is compile-enforced", () => {
	it("a wrong-branded id is not assignable where a specific branded id is expected", () => {
		expectTypeOf<Assignable<UserId, DefinitionId>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<DefinitionId, UserId>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<TermSlug, DefinitionId>>().toEqualTypeOf<false>();
	});

	it("every branded id is still assignable to string (byte-identical shape)", () => {
		expectTypeOf<Assignable<UserId, string>>().toEqualTypeOf<true>();
		expectTypeOf<Assignable<DefinitionId, string>>().toEqualTypeOf<true>();
		expectTypeOf<Assignable<TermSlug, string>>().toEqualTypeOf<true>();
		// ...but a bare string is NOT assignable to a brand (must be minted).
		expectTypeOf<Assignable<string, UserId>>().toEqualTypeOf<false>();
	});

	it("transposing definitionId/voterId at the voteDefinition surface fails to type", () => {
		expectTypeOf<
			Assignable<{definitionId: DefinitionId; voterId: UserId}, VoteDefinitionInput>
		>().toEqualTypeOf<true>();
		expectTypeOf<
			Assignable<{definitionId: UserId; voterId: DefinitionId}, VoteDefinitionInput>
		>().toEqualTypeOf<false>();
	});
});

describe("branded ids — the brand is type-only (runtime byte-identical)", () => {
	it("make() returns the input string unchanged", () => {
		expect(DefinitionId.make("def_abc")).toBe("def_abc");
		expect(UserId.make("user_1")).toBe("user_1");
	});

	it("decode returns the input string unchanged", () => {
		expect(Schema.decodeUnknownSync(DefinitionId)("def_xyz")).toBe("def_xyz");
		expect(Schema.decodeUnknownSync(UserId)("user_2")).toBe("user_2");
	});
});
