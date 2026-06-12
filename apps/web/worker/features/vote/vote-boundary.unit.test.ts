/**
 * Vote feature-boundary pins — the shared low-level vote service depends on
 * no feature directory (the inversion sibling of
 * `../domain-error-boundary.unit.test.ts`).
 *
 * `Vote` is consumed by Sozluk AND Pano, so it sits below the feature
 * directories in the dependency order. The karma counter lives in pasaport's
 * tables, but Vote must not import pasaport to bump it: Vote OWNS the
 * `KarmaBump` contract ("the statement to include in the cast batch") and
 * pasaport PROVIDES the implementation at composition (`fate/layers.ts`).
 * These pins keep that arrow inverted:
 *
 *   1. an import sweep over every module in `vote/` — no import specifier may
 *      reach into a sibling feature directory (pasaport included), so a
 *      re-introduced `../pasaport/karma.ts` import fails here, not in review;
 *   2. type-level pins (expectTypeOf, not `@ts-expect-error` — the effect LSP
 *      plugin's TS377003 escapes the directive, recurring finding): VoteLive's
 *      requirements are exactly `Drizzle | KarmaBump` (the db seam + Vote's
 *      OWN contract — nothing pasaport-shaped), and the contract's surface
 *      names only db primitives (`DrizzleDb` in, `Stmt` out).
 */
import {readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {Layer} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {Drizzle, DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import type {KarmaBump, Vote, VoteLive} from "./Vote.ts";

const voteDir = dirname(fileURLToPath(import.meta.url));

/**
 * Sibling feature directories `vote/` must never import from. `vote/` itself
 * is excluded (own-feature imports are fine); `fate/` is excluded too — it is
 * the composition layer that imports vote, never the reverse, and a `vote/ →
 * fate/` import would be a cycle the sweep should also catch, so it stays in
 * the forbidden list.
 */
const FORBIDDEN_SEGMENTS = ["pasaport", "sozluk", "pano", "stats", "fate", "fate-live"];

describe("vote/ module imports are feature-clean", () => {
	const files = readdirSync(voteDir).filter((f) => f.endsWith(".ts"));

	it.each(files)("%s imports no sibling feature directory", (file) => {
		const source = readFileSync(join(voteDir, file), "utf8");
		const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
		const offending = specifiers.filter((spec) =>
			FORBIDDEN_SEGMENTS.some((seg) => spec.includes(`/${seg}/`)),
		);
		expect(offending, `${file} imports a sibling feature directory`).toEqual([]);
	});
});

describe("Vote's public surface is feature-clean (type pins)", () => {
	it("VoteLive requires exactly the db seam + Vote's own KarmaBump contract", () => {
		// The R channel IS the dependency claim: `Drizzle` (the db seam, below
		// the features) and `KarmaBump` (the contract Vote owns). A re-imported
		// pasaport implementation would drop `KarmaBump` from R (the dep would
		// be baked in again) and fail this exact pin.
		expectTypeOf<typeof VoteLive>().toEqualTypeOf<Layer.Layer<Vote, never, Drizzle | KarmaBump>>();
	});

	it("the KarmaBump contract names only db primitives (DrizzleDb in, Stmt out)", () => {
		// Nothing pasaport-shaped is nameable through the contract: the
		// signature is (db, recipient, delta) → the unexecuted statement Vote
		// batches. This is also künye's swap point — a DO-backed bump replaces
		// the provided value in `fate/layers.ts`, never Vote's internals.
		expectTypeOf<typeof KarmaBump.Service>().toEqualTypeOf<{
			readonly statement: (db: DrizzleDb, userId: string, delta: number) => Stmt;
		}>();
	});
});
