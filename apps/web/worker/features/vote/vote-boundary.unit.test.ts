/**
 * Vote feature-boundary pins — `Vote` is consumed by both Sozluk and Pano, so
 * it sits below the feature directories and must import none of them. The karma
 * counter lives in pasaport's tables, but Vote OWNS the `KarmaBump` contract and
 * pasaport PROVIDES the implementation at composition (`fate/layers.ts`); these
 * pins keep that arrow inverted via (1) an import sweep over every `vote/`
 * module and (2) type-level pins on VoteLive's requirements + the contract surface.
 *
 * Type pins use expectTypeOf, not `@ts-expect-error` — the effect LSP plugin's
 * TS377003 escapes the directive (recurring finding).
 */
import {readdirSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {Layer} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {Drizzle, DrizzleDb, Stmt} from "../../db/Drizzle.ts";
import type {KarmaBump, Vote, VoteLive} from "./Vote.ts";

const voteDir = dirname(fileURLToPath(import.meta.url));

// Sibling feature directories `vote/` must never import from. `fate/` is the
// composition layer that imports vote (never the reverse), so a `vote/ → fate/`
// edge would be a cycle — it stays forbidden too.
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
