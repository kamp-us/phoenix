/**
 * leak-guard's half of the doc-leak vocabulary pin (ADR 0251).
 *
 * `fabrika build check --surface prose` predicts this gate in-tree, and it cannot import this
 * module: ADR 0238 bars a fabrika verb running v1 code, ADR 0273 requires fabrika to work in a repo
 * with no `pipeline-cli`. So it re-declares the shapes, and #3506 is the recorded incident where two
 * copies of these exact patterns drifted after a carve-out landed on one copy only. This test is
 * what makes that drift red instead of silent — it reads fabrika's committed golden fixture, a
 * test-time file read and never an import, and asserts this gate still carries what the fixture
 * pins.
 *
 * Deleting fabrika deletes its fixture and this test with it, leaving the gate whole — which is why
 * ADR 0251 homes the fixture on the fabrika side and the conformance obligation here.
 *
 * Two copies are pinned:
 *
 *  1. `MACHINE_LOCAL_PATH_PATTERNS` against `DOC_PATH_PATTERNS`, through the fixture. Regex source
 *     and flags only — the report `reason` text is each side's own reporting, not shared vocabulary.
 *  2. The **markdown** members of `DOC_SELF_EXEMPT` against `.fabrika.jsonc`'s `docLeakExempt`. Both
 *     of those are this repo's own declarations of one policy, so one test reading both files reds
 *     whichever side moves; there is no third artifact between them and none is wanted, since
 *     neither copy travels outside this repo. The scope is markdown because `--surface prose`
 *     classifies markdown only: this gate also scans a shell surface (epic #4435) that the
 *     predictor has no arm for, and those entries are correctly absent from the config.
 */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {readGoldenFixture} from "../../golden-fixture.ts";
import {DOC_SELF_EXEMPT, surfaceOf} from "./leak-guard.ts";
import {MACHINE_LOCAL_PATH_PATTERNS} from "./path-matcher.ts";

const FIXTURE = "../../../../fabrika-cli/src/build/__fixtures__/doc-leak-patterns.golden.json";
const REPO_CONFIG = "../../../../../.fabrika.jsonc";

interface PinnedPattern {
	readonly source: string;
	readonly flags: string;
}

const pinnedPatterns = (): ReadonlyArray<PinnedPattern> =>
	(
		JSON.parse(readGoldenFixture(import.meta.url, FIXTURE)) as {
			patterns: ReadonlyArray<PinnedPattern>;
		}
	).patterns;

/**
 * `.fabrika.jsonc`'s `docLeakExempt`, read here rather than through fabrika's own JSONC reader —
 * ADR 0251 bans an import edge in either direction. The strip handles whole-line `//` comments,
 * which is the file's entire comment shape; anything richer makes `JSON.parse` throw and reds this
 * test, which is the correct direction for a config nobody can read.
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

describe("the gate conforms to the pinned doc-leak vocabulary (ADR 0251)", () => {
	it("carries the pinned path arms, in the pinned order", () => {
		const declared = MACHINE_LOCAL_PATH_PATTERNS.map(({pattern}) => ({
			source: pattern.source,
			flags: pattern.flags,
		}));
		assert.deepStrictEqual(declared, [...pinnedPatterns()]);
	});
});

describe("the markdown self-exempt list agrees with .fabrika.jsonc", () => {
	it("declares exactly the doc-surface members of DOC_SELF_EXEMPT", () => {
		const docSurface = DOC_SELF_EXEMPT.filter((path) => surfaceOf(path) === "doc");
		assert.deepStrictEqual(sorted(declaredExempt()), sorted(docSurface));
	});

	it("leaves the shell-surface members out — the predictor classifies markdown only", () => {
		const shell = DOC_SELF_EXEMPT.filter((path) => surfaceOf(path) === "shell");
		assert.isAbove(shell.length, 0);
		for (const path of shell) assert.notInclude(declaredExempt(), path);
	});
});
