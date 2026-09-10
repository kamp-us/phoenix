/**
 * fabrika's half of the doc-leak vocabulary pin.
 *
 * `DOC_PATH_PATTERNS` and the host repo's own leak gate must carry the same path shapes, or the
 * in-tree predictor and the gate it predicts disagree on real bytes. No import edge is permitted
 * between the two packages, and fabrika must run in a repo that ships no companion CLI at all, so
 * neither side can derive the shapes from the other. What you do instead: commit the canonical bytes
 * as a golden fixture and have every side pin it in a test of its own, because a docblock promising
 * "these agree" is a promise no repo can keep — two copies of these exact patterns once drifted with
 * nothing red.
 *
 * The fixture is fabrika's, so this test is self-contained: it passes in a repo that ships no
 * conforming side at all. A conforming side reads the same file in its own conformance test — a
 * test-time file read, never an import.
 */
import {describe, expect, it} from "vitest";
import {loadGoldenPayload} from "../golden-fixture.ts";
import {DOC_PATH_PATTERNS} from "./doc-leaks.ts";

interface PinnedPattern {
	readonly source: string;
	readonly flags: string;
}

const pinned = (): ReadonlyArray<PinnedPattern> =>
	loadGoldenPayload(import.meta.url, "./__fixtures__/doc-leak-patterns.golden.json")
		.patterns as ReadonlyArray<PinnedPattern>;

const declared = (): ReadonlyArray<PinnedPattern> =>
	DOC_PATH_PATTERNS.map(({pattern}) => ({source: pattern.source, flags: pattern.flags}));

describe("DOC_PATH_PATTERNS conforms to the pinned doc-leak vocabulary", () => {
	it("carries the pinned arms, in the pinned order", () => {
		expect(declared()).toEqual(pinned());
	});

	it("keeps the `g` flag every arm's per-line matchAll scan needs", () => {
		for (const {flags} of declared()) expect(flags).toContain("g");
	});
});
