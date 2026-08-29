import {strict as assert} from "node:assert";
import {describe, it} from "@effect/vitest";
import {
	DEFAULT_NODE_DETAIL_LEVEL,
	NODE_DETAIL_LEVELS,
	NODE_DETAIL_STORAGE_KEY,
	nodeStatus,
	readStoredNodeDetailLevel,
	writeStoredNodeDetailLevel,
} from "../../src/frontend-shell/node-detail.js";
import type {LineageNode} from "../../src/shared/lineage.js";

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

const lineageNode = (sourceFiles: ReadonlyArray<string>): LineageNode => ({
	id: "pi:status" as LineageNode["id"],
	piSessionId: "status",
	createdAt: 1,
	updatedAt: 2,
	cwd: "/work/status",
	sourceFiles,
});

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

describe("Tuval node freshness status", () => {
	it("uses durable metadata before any live attachment exists", () => {
		assert.deepEqual(nodeStatus(lineageNode(["/fixtures/status.jsonl"]), null), {
			kind: "metadata",
			source: "metadata",
			sourceLabel: "Metadata",
			label: "Kayıtlı görünüm",
			detail: "Canlı bağlantı kurulmadı",
		});
	});

	it("keeps an initially refused disconnected attachment truthful", () => {
		const status = nodeStatus(lineageNode(["/fixtures/status.jsonl"]), {
			connection: "disconnected",
			session: null,
		});

		assert.equal(status.kind, "metadata");
		assert.equal(status.source, "metadata");
		assert.equal(status.label, "Kayıtlı görünüm");
		assert.doesNotMatch(`${status.sourceLabel} ${status.label} ${status.detail}`, /canlı görünüm/i);
	});

	it("reports unknown freshness when refusal has no durable source", () => {
		const status = nodeStatus(lineageNode([]), {
			connection: "disconnected",
			session: null,
		});

		assert.equal(status.kind, "unknown");
		assert.equal(status.source, "unknown");
		assert.equal(status.label, "Tazelik bilinmiyor");
	});
});
