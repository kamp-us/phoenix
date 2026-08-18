/**
 * fabrika's half of the doc-leak vocabulary pin (ADR 0251).
 *
 * `DOC_PATH_PATTERNS` and phoenix's `leak-guard` must carry the same path shapes, or the in-tree
 * predictor and the gate it predicts disagree on real bytes. ADR 0238 bars an import edge between
 * the two packages and ADR 0273 requires fabrika to run in a repo that has no `pipeline-cli`, so
 * neither side can derive the shapes from the other. ADR 0251 rules what you do instead: commit the
 * canonical bytes as a golden fixture and have every side pin it in a test of its own, because a
 * docblock promising "these agree" is a promise no repo can keep — #3506 is the recorded incident
 * where two copies of these exact patterns drifted with nothing red.
 *
 * The fixture is fabrika's, so this test is self-contained: it passes in a repo with no
 * `pipeline-cli` at all. The conforming side reads the same file in
 * `packages/pipeline-cli/src/tools/leak-guard/fabrika-doc-leak-conformance.test.ts` — a test-time
 * file read, never an import.
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
