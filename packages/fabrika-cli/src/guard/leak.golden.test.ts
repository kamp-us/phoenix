/**
 * The gate's half of the doc-leak vocabulary pin (ADR 0251).
 *
 * `build check --surface prose` predicts this gate in-tree from its own copy of the path shapes in
 * `../build/doc-leaks.ts`, and the two copies must carry the same bytes or the predictor and the
 * gate disagree on real files — #3506 is the recorded incident where exactly that drifted with
 * nothing red. Both sides now live in this package, but they stay separate modules because they
 * answer different questions: the predictor scans markdown only and reads its exemptions from
 * `.fabrika.jsonc`, while the gate also scans a shell surface and carries its own self-exempt list.
 * So the fixture stays the arbiter, read at test time and never imported.
 *
 * The second pin is the markdown half of {@link DOC_SELF_EXEMPT} against `.fabrika.jsonc`'s
 * `docLeakExempt` — one policy this repo declares twice, held equal here rather than in a comment.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {loadGoldenPayload} from "../golden-fixture.ts";
import {DOC_SELF_EXEMPT, MACHINE_LOCAL_PATH_PATTERNS, surfaceOf} from "./leak.ts";

const FIXTURE = "../build/__fixtures__/doc-leak-patterns.golden.json";
const REPO_CONFIG = "../../../../.fabrika.jsonc";

interface PinnedPattern {
	readonly source: string;
	readonly flags: string;
}

const pinned = (): ReadonlyArray<PinnedPattern> =>
	loadGoldenPayload(import.meta.url, FIXTURE).patterns as ReadonlyArray<PinnedPattern>;

/**
 * `.fabrika.jsonc`'s `docLeakExempt`, parsed here rather than through the package's own config
 * reader: the point is the bytes on disk, and routing through the reader would let a change to it
 * mask a change to the file. The strip handles whole-line `//` comments, the file's entire comment
 * shape; anything richer makes `JSON.parse` throw and reds this test, which is the right direction
 * for a config nobody can read.
 */
const declaredExempt = (): ReadonlyArray<string> => {
	const text = readFileSync(fileURLToPath(new URL(REPO_CONFIG, import.meta.url)), "utf8");
	const json = text
		.split("\n")
		.filter((line) => !line.trimStart().startsWith("//"))
		.join("\n");
	return (JSON.parse(json) as {docLeakExempt?: ReadonlyArray<string>}).docLeakExempt ?? [];
};

const sorted = (paths: ReadonlyArray<string>): ReadonlyArray<string> => [...paths].sort();

describe("the gate conforms to the pinned doc-leak vocabulary", () => {
	it("carries the pinned path arms, in the pinned order", () => {
		expect(
			MACHINE_LOCAL_PATH_PATTERNS.map(({pattern}) => ({
				source: pattern.source,
				flags: pattern.flags,
			})),
		).toEqual(pinned());
	});
});

describe("the markdown self-exempt list agrees with .fabrika.jsonc", () => {
	it("declares exactly the doc-surface members of DOC_SELF_EXEMPT", () => {
		const docSurface = DOC_SELF_EXEMPT.filter((path) => surfaceOf(path) === "doc");
		expect(sorted(declaredExempt())).toEqual(sorted(docSurface));
	});

	// The predictor classifies markdown only, so the gate's shell entries are correctly absent.
	it("leaves the shell-surface members out", () => {
		const shell = DOC_SELF_EXEMPT.filter((path) => surfaceOf(path) === "shell");
		expect(shell.length).toBeGreaterThan(0);
		for (const path of shell) expect(declaredExempt()).not.toContain(path);
	});
});
