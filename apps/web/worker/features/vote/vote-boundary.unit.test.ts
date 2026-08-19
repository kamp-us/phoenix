/**
 * Vote feature-boundary pins — `Vote` is consumed by both Sozluk and Pano, so it sits
 * below the feature directories and must import none of them. Vote OWNS the `KarmaBump`
 * and `VoterStanding` contracts; pasaport/künye PROVIDE the implementations at
 * composition. Asserting what `VoteLive` REQUIRES is what keeps those arrows inverted:
 * a re-imported sibling implementation would widen `R` and fail the pin.
 *
 * Pins use `expectTypeOf`, not `@ts-expect-error` — the effect LSP plugin's TS377003
 * escapes the directive.
 */
import type {Effect, Layer} from "effect";
import {describe, expectTypeOf, it} from "vitest";
import type {Drizzle, DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import type {Telemetry} from "../telemetry/Telemetry.ts";
import type {KarmaBump, KarmaBumpInput, Vote, VoteLive, VoterStanding} from "./Vote.ts";

describe("Vote's public surface is feature-clean (type pins)", () => {
	it("VoteLive requires the db seam + Vote's own KarmaBump + VoterStanding + the shared Telemetry seam", () => {
		// A re-imported pasaport/künye implementation would bake the dep in and drop
		// `KarmaBump`/`VoterStanding` from R, failing this pin. `Telemetry` rides `R`
		// un-inverted on purpose: it is a low-level seam, not a peer feature (ADR 0153).
		expectTypeOf<typeof VoteLive>().toEqualTypeOf<
			Layer.Layer<Vote, never, Drizzle | KarmaBump | VoterStanding | Telemetry>
		>();
	});

	it("the KarmaBump contract names only db primitives (DrizzleDb + KarmaBumpInput in, Stmt pair out)", () => {
		// Nothing pasaport-shaped is nameable through the contract — only db-level primitives
		// in, a `[Stmt, Stmt]` bump + ledger pair out (#2592). Also künye's swap point: a
		// DO-backed bump replaces the provided value at composition, never Vote's internals.
		expectTypeOf<typeof KarmaBump.Service>().toEqualTypeOf<{
			readonly statements: (db: DrizzleDb, input: KarmaBumpInput) => readonly [Stmt, Stmt];
		}>();
	});

	it("the VoterStanding contract names only a voter id → boolean predicate (no tier vocabulary)", () => {
		// Nothing künye-shaped (no `Tier`, no ladder) is nameable here: the "above the çaylak
		// floor" comparison lives at the künye seam, so the ladder can move without Vote (#1810).
		expectTypeOf<typeof VoterStanding.Service>().toEqualTypeOf<{
			readonly isAboveNewcomer: (voterId: string) => Effect.Effect<boolean>;
		}>();
	});
});
