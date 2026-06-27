/**
 * The sözlük `Definition` wire shaper (`toDefinition`) takes the map-derived
 * `DefinitionRow` from the one `definition-fields.ts` column→field map (#1126
 * AC#1; the sözlük mirror of pano's #1161 collapse in PR #1265, the last #1161
 * remainder — #1268). This pins that seam: the record → `toDefinitionRow` →
 * `toDefinition` path yields the byte-identical canonical `{__typename, …}` wire
 * object, with the `myVote` viewer-scalar default stamped to `null` — so
 * divergence between the map and the wire shaper is unrepresentable, generalizing
 * #1170 from one field to the whole object.
 */
import {assert, describe, it} from "@effect/vitest";
import type * as schema from "../../db/drizzle/schema.ts";
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
	lastEventId: "",
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
			createdAt: new Date(1000),
			updatedAt: new Date(2000),
			myVote: null,
		});
	});

	it("the shaper emits exactly the `Definition` key set with the viewer-scalar default", () => {
		const wire = toDefinition(toDefinitionRow(baseRecord()));

		assert.deepStrictEqual(Object.keys(wire).sort(), [
			"__typename",
			"author",
			"authorId",
			"body",
			"createdAt",
			"id",
			"myVote",
			"score",
			"updatedAt",
		]);
		assert.strictEqual(wire.__typename, "Definition");
		// No viewer scalar stamped on a bare row read → defaulted to `null`.
		assert.strictEqual(wire.myVote, null);
	});

	it("the `myVote` viewer scalar passes through the shaper when stamped on the row", () => {
		const voted = toDefinition({...toDefinitionRow(baseRecord()), myVote: true});
		assert.strictEqual(voted.myVote, true);
	});
});
