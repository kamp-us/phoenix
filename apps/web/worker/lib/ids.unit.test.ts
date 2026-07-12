/**
 * Branded id pins (#2712, epic #2700). Two tiers:
 *
 *  - TYPE tier: nominal distinctness is compile-enforced — a `UserId` is not
 *    assignable where a `DefinitionId` is expected, and transposing the two at
 *    the `voteDefinition` arg surface fails to type. Assignability is encoded as
 *    a conditional-type boolean checked with `expectTypeOf` (not
 *    `@ts-expect-error`, which the effect LSP plugin's TS377003 escapes — the
 *    recurring finding in `domain-error-boundary.unit.test.ts`).
 *  - RUNTIME tier: the brand is type-only — `.make` and decode return the input
 *    string unchanged, so wire/D1 bytes are byte-identical (no allocation or
 *    serialization delta).
 */
import * as Schema from "effect/Schema";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {VoteDefinitionInput} from "../features/sozluk/Sozluk.ts";
import {DefinitionId, type TermSlug, UserId} from "./ids.ts";

// `A extends B` as a checkable boolean — `true` iff an `A` is assignable to a `B`.
type Assignable<A, B> = [A] extends [B] ? true : false;

describe("branded ids — nominal distinctness is compile-enforced", () => {
	it("a wrong-branded id is not assignable where a specific branded id is expected", () => {
		// The core guarantee: distinct brands are mutually unassignable.
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
		// The correct shape is a VoteDefinitionInput; the swapped shape is not —
		// this is the #2712 arg-swap, now a compile error at every call site.
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
