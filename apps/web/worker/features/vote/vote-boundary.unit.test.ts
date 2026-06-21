/**
 * Vote feature-boundary pins — `Vote` is consumed by both Sozluk and Pano, so
 * it sits below the feature directories and must import none of them. The karma
 * counter lives in pasaport's tables, but Vote OWNS the `KarmaBump` contract and
 * pasaport PROVIDES the implementation at composition (`fate/layers.ts`); these
 * type-level pins keep that arrow inverted by asserting what `VoteLive` REQUIRES
 * (its `R` channel) and the shape of the contract surface — the boundary's actual
 * requirement, refactor-proof. A re-imported sibling implementation would widen
 * `R` and fail the pin; nothing sibling-shaped is nameable through the contract.
 *
 * Type pins use expectTypeOf, not `@ts-expect-error` — the effect LSP plugin's
 * TS377003 escapes the directive (recurring finding).
 */
import type {Layer} from "effect";
import {describe, expectTypeOf, it} from "vitest";
import type {Drizzle, DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import type {KarmaBump, Vote, VoteLive} from "./Vote.ts";

describe("Vote's public surface is feature-clean (type pins)", () => {
	it("VoteLive requires exactly the db seam + Vote's own KarmaBump contract", () => {
		// A re-imported pasaport implementation would bake the dep in and drop
		// `KarmaBump` from R, failing this pin.
		expectTypeOf<typeof VoteLive>().toEqualTypeOf<Layer.Layer<Vote, never, Drizzle | KarmaBump>>();
	});

	it("the KarmaBump contract names only db primitives (DrizzleDb in, Stmt out)", () => {
		// Nothing pasaport-shaped is nameable through the contract. Also künye's
		// swap point — a DO-backed bump replaces the provided value in
		// `fate/layers.ts`, never Vote's internals.
		expectTypeOf<typeof KarmaBump.Service>().toEqualTypeOf<{
			readonly statement: (db: DrizzleDb, userId: string, delta: number) => Stmt;
		}>();
	});
});
