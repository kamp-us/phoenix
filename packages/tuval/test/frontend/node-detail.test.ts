import {strict as assert} from "node:assert";
import {describe, it} from "@effect/vitest";
import {
	DEFAULT_NODE_DETAIL_LEVEL,
	NODE_DETAIL_LEVELS,
	NODE_DETAIL_STORAGE_KEY,
	readStoredNodeDetailLevel,
	writeStoredNodeDetailLevel,
} from "../../src/frontend-shell/node-detail.js";

const storage = (initial?: Readonly<Record<string, string>>): Storage => {
	const values = new Map(Object.entries(initial ?? {}));
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => void values.delete(key),
		setItem: (key, value) => void values.set(key, value),
	};
};

describe("Tuval node detail workspace setting", () => {
	it("accepts exactly the four ruled levels and defaults to meta", () => {
		assert.deepEqual(NODE_DETAIL_LEVELS, ["bare", "meta", "live", "full"]);
		assert.equal(DEFAULT_NODE_DETAIL_LEVEL, "meta");
		assert.equal(readStoredNodeDetailLevel(storage({[NODE_DETAIL_STORAGE_KEY]: "full"})), "full");
		assert.equal(
			readStoredNodeDetailLevel(storage({[NODE_DETAIL_STORAGE_KEY]: "expanded"})),
			"meta",
		);
	});

	it("persists a valid choice without making unavailable storage fatal", () => {
		const available = storage();
		writeStoredNodeDetailLevel(available, "live");
		assert.equal(readStoredNodeDetailLevel(available), "live");
		assert.equal(readStoredNodeDetailLevel(undefined), "meta");
		assert.doesNotThrow(() =>
			writeStoredNodeDetailLevel(
				{
					...available,
					setItem: () => {
						throw new Error("storage unavailable");
					},
				},
				"bare",
			),
		);
	});
});
