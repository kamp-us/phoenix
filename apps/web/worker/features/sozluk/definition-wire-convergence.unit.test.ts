/**
 * Pins the sözlük `Definition` seam: record → `toDefinitionRow` → `toDefinition` yields the
 * byte-identical canonical wire object, so divergence between the one `definition-fields.ts`
 * column→field map and the wire shaper is unrepresentable (#1268, the sözlük mirror of #1265).
 */
import {assert, describe, it} from "@effect/vitest";
import type * as schema from "../../db/drizzle/schema.ts";
import {EMPTY_REACTION_AGGREGATE} from "../reaction/Reaction.ts";
import {toDefinitionRow} from "./definition-fields.ts";
import {toDefinition} from "./shapers.ts";

type DefinitionRecord = typeof schema.definitionRecord.$inferSelect;

const baseRecord = (): DefinitionRecord => ({
	id: "def-1",
	authorId: "user-1",
	authorName: "umut",
	termSlug: "baslik",
	termTitle: "başlık",
	body: "tanım gövdesi",
	bodyExcerpt: "tanım…",
	score: 5,
	createdAt: new Date(1000),
	updatedAt: new Date(2000),
	removedAt: null,
	removedBy: null,
	removedReason: null,
	sandboxedAt: null,
});

describe("Sözlük Definition wire shaper — derived from the one column→field map (#1268, mirrors #1265)", () => {
	it("record → row → shaper yields the canonical wire object", () => {
		const wire = toDefinition(toDefinitionRow(baseRecord()));

		assert.deepStrictEqual(wire, {
			__typename: "Definition",
			id: "def-1",
			body: "tanım gövdesi",
			score: 5,
			author: "umut",
			authorId: "user-1",
			// `stampAuthorIdentity` runs on the service read path (#2139), not on a bare row read.
			authorUsername: null,
			authorDisplayName: null,
			createdAt: new Date(1000),
			updatedAt: new Date(2000),
			myVote: null,
			// Owner-scoped in-review flag (#2200): defaults `false` so a bare row never leaks review state.
			sandboxed: false,
			reactions: EMPTY_REACTION_AGGREGATE,
		});
	});

	it("the shaper emits exactly the `Definition` key set with the viewer-scalar default", () => {
		const wire = toDefinition(toDefinitionRow(baseRecord()));

		assert.deepStrictEqual(Object.keys(wire).sort(), [
			"__typename",
			"author",
			"authorDisplayName",
			"authorId",
			"authorUsername",
			"body",
			"createdAt",
			"id",
			"myVote",
			"reactions",
			"sandboxed",
			"score",
			"updatedAt",
		]);
		assert.strictEqual(wire.__typename, "Definition");
		assert.strictEqual(wire.myVote, null);
		assert.strictEqual(wire.sandboxed, false);
		assert.deepStrictEqual(wire.reactions, EMPTY_REACTION_AGGREGATE);
	});

	it("the `myVote` viewer scalar passes through the shaper when stamped on the row", () => {
		const voted = toDefinition({...toDefinitionRow(baseRecord()), myVote: true});
		assert.strictEqual(voted.myVote, true);
	});
});
