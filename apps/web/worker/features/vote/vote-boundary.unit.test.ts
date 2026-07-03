/**
 * Vote feature-boundary pins — `Vote` is consumed by both Sozluk and Pano, so
 * it sits below the feature directories and must import none of them. The karma
 * counter lives in pasaport's tables and the voter tier lives in künye's, but Vote
 * OWNS both the `KarmaBump` and `VoterStanding` contracts and pasaport/künye PROVIDE
 * the implementations at composition (`fate/layers.ts`); these type-level pins keep
 * those arrows inverted by asserting what `VoteLive` REQUIRES (its `R` channel) and
 * the shape of each contract surface — the boundary's actual requirement,
 * refactor-proof. A re-imported sibling implementation would widen `R` and fail the
 * pin; nothing sibling-shaped is nameable through either contract.
 *
 * Type pins use expectTypeOf, not `@ts-expect-error` — the effect LSP plugin's
 * TS377003 escapes the directive (recurring finding).
 */
import type {Effect, Layer} from "effect";
import {describe, expectTypeOf, it} from "vitest";
import type {Drizzle, DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import type {KarmaBump, Vote, VoteLive, VoterStanding} from "./Vote.ts";

describe("Vote's public surface is feature-clean (type pins)", () => {
	it("VoteLive requires exactly the db seam + Vote's own KarmaBump + VoterStanding contracts", () => {
		// A re-imported pasaport/künye implementation would bake the dep in and drop
		// `KarmaBump`/`VoterStanding` from R, failing this pin.
		expectTypeOf<typeof VoteLive>().toEqualTypeOf<
			Layer.Layer<Vote, never, Drizzle | KarmaBump | VoterStanding>
		>();
	});

	it("the KarmaBump contract names only db primitives (DrizzleDb in, Stmt out)", () => {
		// Nothing pasaport-shaped is nameable through the contract. Also künye's
		// swap point — a DO-backed bump replaces the provided value in
		// `fate/layers.ts`, never Vote's internals.
		expectTypeOf<typeof KarmaBump.Service>().toEqualTypeOf<{
			readonly statement: (db: DrizzleDb, userId: string, delta: number) => Stmt;
		}>();
	});

	it("the VoterStanding contract names only a voter id → boolean predicate (no tier vocabulary)", () => {
		// Nothing künye-shaped (no `Tier`, no ladder) is nameable through the contract —
		// the "above the çaylak floor" comparison lives at the künye seam (`fate/layers.ts`),
		// so the ladder can move without touching Vote. #1810.
		expectTypeOf<typeof VoterStanding.Service>().toEqualTypeOf<{
			readonly isAboveNewcomer: (voterId: string) => Effect.Effect<boolean>;
		}>();
	});
});
