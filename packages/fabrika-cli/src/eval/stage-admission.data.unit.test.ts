/**
 * The stage-admission rule, enforced instead of merely written down (#4981, epic #4960).
 *
 * The rule is in `README.md`: a stage enters `STAGES` when its skill exists and there is something
 * to grade under it, and not before. Prose alone cannot hold it — `STAGES` is a plain tuple that no
 * type relates to `oracle.ts`'s grader arms, to `CorpusManifest`'s keys, or to the skills on disk,
 * so a name added to it typechecks clean while grading nothing. These are data tests over the real
 * `STAGES`, `oracle.ts`, corpus manifests and README, so adding an inadmissible stage turns the
 * suite red.
 *
 * The grader-arm check calls `gradeEntry` with a probe entry rather than reading the switch as text:
 * a stage with no arm falls off the end of a `default`-less switch and returns `undefined`, which is
 * the failure a source-text match would only approximate.
 */
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {assert, describe, it} from "@effect/vitest";
import {Result} from "effect";
import {
	type CorpusEntry,
	decodeManifest,
	type LiveStage,
	REVIEW_SURFACES,
	STAGES,
} from "./corpus.ts";
import {type Grade, gradeEntry} from "./oracle.ts";

/**
 * Which fabrika skill each live stage grades. A stage key and its skill's directory need not be the
 * same string — `ship-it`'s skill is `ship`, and renaming the stage is not this harness's call
 * (#4960). Typed total over `LiveStage`, so a new stage with no entry also fails `pnpm typecheck`.
 */
const STAGE_SKILLS: Record<LiveStage, string> = {
	triage: "triage",
	build: "build",
	review: "review",
	"ship-it": "ship",
};

const skillPath = (skill: string): string =>
	fileURLToPath(
		new URL(`../../../../claude-plugins/fabrika/skills/${skill}/SKILL.md`, import.meta.url),
	);

const CORPUS_DIR = fileURLToPath(new URL("./corpus", import.meta.url));

const README = readFileSync(fileURLToPath(new URL("./README.md", import.meta.url)), "utf8");

/** The lines of one `##`/`###` README section, up to the next heading of either depth. */
const sectionBody = (heading: string): string => {
	const start = README.indexOf(`\n${heading}\n`);
	if (start === -1) return "";
	const rest = README.slice(start + heading.length + 2);
	const end = rest.search(/\n#{2,3} /);
	return end === -1 ? rest : rest.slice(0, end);
};

/** The first backticked token of each top-level bullet in a section — the section's named stages. */
const bulletedNames = (heading: string): ReadonlyArray<string> =>
	[...sectionBody(heading).matchAll(/^- `([^`]+)`/gm)].map((match) => match[1] as string);

const UNGRADED_HEADING = "### Stages carrying zero committed corpus entries";
const NO_STAGE_HEADING = "### Fabrika surfaces that deliberately have no stage today";

/** Every committed manifest, decoded — a manifest that does not decode is `corpus.data`'s failure. */
const committedManifests = readdirSync(CORPUS_DIR)
	.filter((name) => name.endsWith(".json"))
	.map((name) => decodeManifest(readFileSync(`${CORPUS_DIR}/${name}`, "utf8")))
	.flatMap((result) => (Result.isSuccess(result) ? [result.success] : []));

// Widened on purpose: a stage with no manifest key has no group here, and that must count as zero
// entries so the ungraded-list assertion reports it — not throw before it can.
const committedEntryCount = (stage: LiveStage): number =>
	committedManifests.reduce((total, manifest) => {
		const groups = manifest.stages as Readonly<Record<string, ReadonlyArray<unknown>>>;
		return total + (groups[stage]?.length ?? 0);
	}, 0);

/**
 * A probe entry for one stage, built across the JSON boundary — which is both how a real corpus row
 * arrives and the only way to hand `gradeEntry` a stage the type system says cannot exist. Writing
 * it as a literal is impossible by construction: an inadmissible stage is not in `CorpusEntry`, and
 * that gap is the whole thing being probed.
 */
const probeEntry = (stage: string, surface?: string): CorpusEntry =>
	JSON.parse(JSON.stringify({stage, surface, inputRef: 0, label: {}}));

/**
 * One probe per grader arm a stage owns. `review` fans on `surface` (ADR 0243), so it is probed on
 * every surface — a stage whose second discriminator lost an arm fails here too.
 */
const probesFor = (stage: LiveStage): ReadonlyArray<CorpusEntry> =>
	stage === "review"
		? REVIEW_SURFACES.map((surface) => probeEntry(stage, surface))
		: [probeEntry(stage)];

describe("stage admission — the rule fails closed before it checks anything", () => {
	// Without this, an emptied STAGES generates zero per-stage cases and the suite passes vacuously.
	it("STAGES is non-empty", () => {
		assert.isAtLeast(STAGES.length, 1, "an empty stage vocabulary is a failure, not a pass");
	});
});

describe("stage admission — every stage has a grader arm, a manifest key and a skill", () => {
	for (const stage of STAGES) {
		it(`${stage} reaches a grader arm in oracle.ts`, () => {
			for (const probe of probesFor(stage)) {
				// A stage with no `case` falls off the switch and yields undefined, never a Grade.
				const grade: Grade | undefined = gradeEntry(probe, {});
				assert.isDefined(grade, `${stage} has no grader arm in oracle.ts's gradeEntry switch`);
			}
		});

		it(`${stage}'s skill exists on disk`, () => {
			const skill = STAGE_SKILLS[stage] as string | undefined;
			assert.isDefined(skill, `${stage} names no fabrika skill in STAGE_SKILLS`);
			assert.isTrue(
				existsSync(skillPath(skill as string)),
				`${stage} has no skill at claude-plugins/fabrika/skills/${skill}/SKILL.md — a stage exists when its skill does`,
			);
		});
	}

	it("CorpusManifest carries exactly one key per stage, and no others", () => {
		const probe = {
			version: 1,
			stages: Object.fromEntries(STAGES.map((stage) => [stage, []])),
		};
		const decoded = decodeManifest(JSON.stringify(probe));
		assert.isTrue(
			Result.isSuccess(decoded),
			"a manifest keyed by exactly STAGES must decode — a stage with no CorpusManifest key does not",
		);
		if (Result.isSuccess(decoded)) {
			assert.deepStrictEqual(Object.keys(decoded.success.stages).sort(), [...STAGES].sort());
		}
	});
});

describe("stage admission — an ungraded stage is a recorded choice (README)", () => {
	it("every stage with zero committed entries is named in the README's ungraded list", () => {
		const zeroEntry = STAGES.filter((stage) => committedEntryCount(stage) === 0);
		const listed = bulletedNames(UNGRADED_HEADING);
		assert.isNotEmpty(
			sectionBody(UNGRADED_HEADING),
			`the README must carry the "${UNGRADED_HEADING}" section`,
		);
		assert.deepStrictEqual(
			[...listed].sort(),
			[...zeroEntry].sort(),
			"the README's ungraded list must be exactly the stages carrying zero committed entries",
		);
	});

	it("the deliberately-stage-less surfaces are not stages", () => {
		const stageless = bulletedNames(NO_STAGE_HEADING);
		assert.isNotEmpty(stageless, `the README must carry the "${NO_STAGE_HEADING}" section`);
		for (const surface of stageless) {
			assert.notInclude(
				[...STAGES] as ReadonlyArray<string>,
				surface,
				`${surface} is listed as stage-less but is in STAGES`,
			);
		}
	});
});
