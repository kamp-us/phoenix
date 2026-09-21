/**
 * The pure rule behind `guard skill-evidence-guard check`: the fail-closed zero verdict, the skip
 * seats, the typo lane's arithmetic, the report schema, the version bindings, the thresholds, and
 * the provenance trust chain. No IO — that is `./skill-evidence-verb.unit.test.ts`.
 */
import {describe, expect, it} from "vitest";
import {
	diffWords,
	editDistance,
	groupSkillFiles,
	judge,
	type ProvenanceFacts,
	parsePolicy,
	type ReportOutcome,
	type RunFacts,
	type SkillEvidenceFacts,
	type SkillEvidencePolicy,
	type SkillFacts,
	type Thresholds,
	type TypoFacts,
	validateReport,
	ZERO_FILES_REPORT,
} from "./skill-evidence.ts";
import type {GuardVerdict} from "./verdict.ts";

const SKILLS = "claude-plugins/fabrika/skills";
const REPORTS = "benchmarks/skill-evidence/reports";
const PRODUCER = ".github/workflows/skill-benchmark.yml";

const TREE_HEAD = `a${"1".repeat(39)}`;
const TREE_BASE = `b${"2".repeat(39)}`;
const TREE_OTHER = `c${"3".repeat(39)}`;
const HEAD_SHA = `d${"4".repeat(39)}`;
const RUN = 4242;

const DEFAULTS: Thresholds = {
	minRepetitions: 3,
	successDelta: 0,
	newCriticalErrors: 0,
	maxCostRatio: 1.25,
};

const POLICY: SkillEvidencePolicy = {
	producerWorkflow: PRODUCER,
	skillsRoot: SKILLS,
	reportRoot: REPORTS,
	thresholds: {default: DEFAULTS, perSkill: {}},
	typoExemption: {mdOnly: true, maxChangedWords: 20, maxWordEditDistance: 2},
};

const goodRun: RunFacts = {
	exists: true,
	path: PRODUCER,
	status: "completed",
	conclusion: "success",
	headSha: HEAD_SHA,
};

const goodProvenance: ProvenanceFacts = {
	reachable: true,
	run: goodRun,
	tokenPresent: true,
	benchmarkTreeAtHeadSha: TREE_HEAD,
};

/** Not typo-exempt by default: many changed words, so a case opts INTO the lane explicitly. */
const behaviorChange: TypoFacts = {nonMdFiles: [], mdFiles: 1, changedWords: 999, pairs: []};

const arm = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	scenarios: 10,
	success: 5,
	criticalErrors: 0,
	tokens: 1000,
	costUsd: 1,
	...over,
});

const reportValue = (name: string, over: Record<string, unknown> = {}): unknown => ({
	schemaVersion: 1,
	skill: {name, path: `${SKILLS}/${name}`, treeSha: TREE_HEAD},
	baseline: {kind: "without-skill"},
	model: "test-model",
	tools: "test-tools",
	scenarioSet: "set-a",
	repetitions: 3,
	results: {baseline: arm(), treatment: arm({success: 7})},
	thresholds: DEFAULTS,
	provenance: {
		workflow: PRODUCER,
		runId: RUN,
		runUrl: `https://github.com/o/r/actions/runs/${RUN}`,
		headSha: HEAD_SHA,
	},
	...over,
});

const skill = (name: string, over: Partial<SkillFacts> = {}): SkillFacts => ({
	name,
	existsAtHead: true,
	existsAtBase: false,
	headTreeSha: TREE_HEAD,
	baseTreeSha: null,
	changedFiles: [`${SKILLS}/${name}/SKILL.md`],
	typo: behaviorChange,
	report: {_tag: "Json", value: reportValue(name)} as ReportOutcome,
	provenance: goodProvenance,
	...over,
});

const facts = (
	files: ReadonlyArray<string>,
	skills: ReadonlyArray<SkillFacts>,
	policy: SkillEvidencePolicy = POLICY,
): SkillEvidenceFacts => ({files, skills, policy});

const isViolation = (verdict: GuardVerdict) => (verdict._tag === "Violation" ? verdict : null);

describe("judge — fail-closed on zero scope (fail-closed)", () => {
	it("FAILS with zero-scope when handed ZERO files, whatever else is true", () => {
		const verdict = judge(facts([], [skill("build")]));
		expect(verdict._tag).toBe("ZeroScope");
		expect(verdict._tag === "ZeroScope" && verdict.report).toBe(ZERO_FILES_REPORT);
		expect(verdict._tag === "ZeroScope" && verdict.report).toContain("handed ZERO files");
	});

	it("SKIPS when no changed file sits under the skills root", () => {
		const verdict = judge(facts(["README.md", "worker/src/index.ts"], []));
		expect(verdict._tag).toBe("Skipped");
		expect(verdict._tag === "Skipped" && verdict.summary).toContain("0 of 2 changed files under");
	});
});

describe("judge — removed and exempt skills are not gated", () => {
	it("records a removed skill and asks for no evidence", () => {
		const gone = skill("old-thing", {
			existsAtHead: false,
			headTreeSha: null,
			report: {_tag: "ReadError", reason: "missing"},
		});
		const verdict = judge(facts([`${SKILLS}/old-thing/SKILL.md`], [gone]));
		expect(verdict._tag).toBe("Skipped");
		expect(verdict._tag === "Skipped" && verdict.summary).toContain(
			"1 skill(s) removed — no evidence required to delete",
		);
	});

	it("exempts a typo-only change and NAMES the numbers that earned the exemption", () => {
		const typo: TypoFacts = {
			nonMdFiles: [],
			mdFiles: 1,
			changedWords: 2,
			pairs: [{old: "recieve", new: "receive"}],
		};
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {typo, report: {_tag: "ReadError", reason: "missing"}})],
			),
		);
		expect(verdict._tag).toBe("Skipped");
		expect(verdict._tag === "Skipped" && verdict.summary).toContain("1 typo-exempt: build");
		expect(verdict._tag === "Skipped" && verdict.summary).toContain(
			"2 changed words across 1 .md file(s), max pair distance 2",
		);
	});

	it.each([
		[
			"a non-.md changed file",
			{
				nonMdFiles: [`${SKILLS}/build/scripts/verify.py`],
				mdFiles: 0,
				changedWords: 0,
				pairs: [],
			} satisfies TypoFacts,
		],
		[
			"more changed words than the cap",
			{nonMdFiles: [], mdFiles: 1, changedWords: 21, pairs: []} satisfies TypoFacts,
		],
		[
			"a word pair beyond the edit-distance cap",
			{
				nonMdFiles: [],
				mdFiles: 1,
				changedWords: 2,
				pairs: [{old: "abc", new: "abcdef"}],
			} satisfies TypoFacts,
		],
	])("does NOT exempt %s — the skill is gated and reds on its missing report", (_name, typo) => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {typo, report: {_tag: "ReadError", reason: "missing"}})],
			),
		);
		expect(verdict._tag).toBe("Violation");
		expect(verdict._tag === "Violation" && verdict.report).toContain("missing");
	});
});

describe("judge — the report must exist and hold the schema", () => {
	it("reds a missing report, naming the expected path", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {report: {_tag: "ReadError", reason: "missing"}})],
			),
		);
		const violation = isViolation(verdict);
		expect(violation).not.toBeNull();
		expect(violation?.report).toContain(`${REPORTS}/build/report.json`);
		expect(violation?.report).toContain("missing");
	});

	it("reds an unparseable report the same way", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {report: {_tag: "ReadError", reason: "not valid JSON: x"}})],
			),
		);
		expect(isViolation(verdict)?.report).toContain("not valid JSON");
	});

	it.each([
		["a bumped schemaVersion", {schemaVersion: 2}, "schemaVersion must be 1"],
		["an unknown top-level field", {extra: true}, "unknown field(s) extra"],
		["a missing model", {model: ""}, "model must be a non-empty string"],
		[
			"a wrong-typed arm count",
			{results: {baseline: arm({scenarios: "ten"}), treatment: arm()}},
			"results.baseline.scenarios must be a non-negative integer",
		],
		[
			"a non-number cost",
			{results: {baseline: arm({costUsd: "free"}), treatment: arm()}},
			"results.baseline.costUsd must be a number",
		],
		["zero repetitions", {repetitions: 0}, "repetitions must be a positive integer"],
		[
			"a garbage baseline kind",
			{baseline: {kind: "gold"}},
			'baseline.kind must be "without-skill" or "previous-version"',
		],
		[
			"a missing provenance workflow",
			{provenance: {runId: RUN, runUrl: "https://x", headSha: HEAD_SHA}},
			"provenance.workflow must be a non-empty string",
		],
		[
			"a missing provenance runUrl",
			{provenance: {workflow: PRODUCER, runId: RUN, headSha: HEAD_SHA}},
			"provenance.runUrl must be a non-empty string",
		],
		[
			"a missing provenance runId",
			{provenance: {workflow: PRODUCER, runUrl: "https://x", headSha: HEAD_SHA}},
			"provenance.runId must be a positive integer",
		],
	])("reds %s by field path", (_name, over, fragment) => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {report: {_tag: "Json", value: reportValue("build", over)}})],
			),
		);
		const violation = isViolation(verdict);
		expect(violation).not.toBeNull();
		expect(violation?.report).toContain("fails the report schema (schemaVersion 1)");
		expect(violation?.report).toContain(fragment);
	});
});

describe("judge — version binding: the evidence must be THIS change's", () => {
	it("reds a stale treatment treeSha with got-vs-expected", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[
					skill("build", {
						report: {
							_tag: "Json",
							value: reportValue("build", {
								skill: {name: "build", path: `${SKILLS}/build`, treeSha: TREE_OTHER},
							}),
						},
					}),
				],
			),
		);
		const violation = isViolation(verdict);
		expect(violation?.report).toContain("stale evidence: report attests skill tree");
		expect(violation?.report).toContain(TREE_OTHER);
		expect(violation?.report).toContain(TREE_HEAD);
	});

	it("reds a report whose skill.path is not the actual skill path", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[
					skill("build", {
						report: {
							_tag: "Json",
							value: reportValue("build", {
								skill: {name: "build", path: `${SKILLS}/other`, treeSha: TREE_HEAD},
							}),
						},
					}),
				],
			),
		);
		expect(isViolation(verdict)?.report).toContain("report.skill.path is");
	});

	it("reds an UPDATED skill whose baseline arm is not the previous version", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {existsAtBase: true, baseTreeSha: TREE_BASE})],
			),
		);
		expect(isViolation(verdict)?.report).toContain(
			'expected "previous-version" — an UPDATED skill',
		);
	});

	it("reds an UPDATED skill whose previous-version treeSha is stale", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[
					skill("build", {
						existsAtBase: true,
						baseTreeSha: TREE_BASE,
						report: {
							_tag: "Json",
							value: reportValue("build", {
								baseline: {kind: "previous-version", treeSha: TREE_OTHER},
							}),
						},
					}),
				],
			),
		);
		const violation = isViolation(verdict);
		expect(violation?.report).toContain("stale baseline");
		expect(violation?.report).toContain(TREE_OTHER);
	});

	it("reds a NEW skill whose baseline arm is not without-skill", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[
					skill("build", {
						report: {
							_tag: "Json",
							value: reportValue("build", {
								baseline: {kind: "previous-version", treeSha: TREE_BASE},
							}),
						},
					}),
				],
			),
		);
		expect(isViolation(verdict)?.report).toContain('expected "without-skill" — a NEW skill');
	});
});

describe("judge — thresholds: the policy's numbers, met", () => {
	it("reds a report judged against a threshold set the policy did not apply", () => {
		const shopping = {...DEFAULTS, minRepetitions: 1};
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[
					skill("build", {
						report: {_tag: "Json", value: reportValue("build", {thresholds: shopping})},
					}),
				],
			),
		);
		const violation = isViolation(verdict);
		expect(violation?.report).toContain("report.thresholds is");
		expect(violation?.report).toContain("no post-hoc threshold shopping");
	});

	it("reds policy perSkill keys the gate does not know", () => {
		const policy: SkillEvidencePolicy = {
			...POLICY,
			thresholds: {default: DEFAULTS, perSkill: {build: {maxCostRatiox: 2}}},
		};
		const verdict = judge(facts([`${SKILLS}/build/SKILL.md`], [skill("build")], policy));
		expect(isViolation(verdict)?.report).toContain("policy names keys the gate does not know");
	});

	it("accepts a per-skill override the report matches, and judges by it", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[
					skill("build", {
						report: {
							_tag: "Json",
							value: reportValue("build", {
								repetitions: 1,
								thresholds: {...DEFAULTS, minRepetitions: 1},
							}),
						},
					}),
				],
				{...POLICY, thresholds: {default: DEFAULTS, perSkill: {build: {minRepetitions: 1}}}},
			),
		);
		expect(verdict._tag).toBe("Clean");
	});

	it.each([
		["too few repetitions", {repetitions: 2}, "repetitions 2 < minRepetitions 3"],
		[
			"a negative success delta",
			{results: {baseline: arm(), treatment: arm({success: 4})}},
			"successDelta -1",
		],
		[
			"new critical errors",
			{results: {baseline: arm(), treatment: arm({success: 7, criticalErrors: 2})}},
			"newCriticalErrors 2",
		],
		[
			"cost over the ratio cap",
			{results: {baseline: arm(), treatment: arm({success: 7, costUsd: 2})}},
			"exceeds the cap over baseline",
		],
		[
			"cost over the absolute budget of a zero-cost baseline",
			{results: {baseline: arm({costUsd: 0}), treatment: arm({success: 7, costUsd: 2})}},
			"zero-cost baseline so the ratio is an absolute budget",
		],
		[
			"a different scenario count per arm",
			{results: {baseline: arm({scenarios: 10}), treatment: arm({success: 7, scenarios: 9})}},
			"arms ran different scenario sets",
		],
	])("reds %s", (_name, over, fragment) => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {report: {_tag: "Json", value: reportValue("build", over)}})],
			),
		);
		expect(isViolation(verdict)?.report).toContain(fragment);
	});

	it("passes a treatment that costs exactly the ratio cap", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[
					skill("build", {
						report: {
							_tag: "Json",
							value: reportValue("build", {
								results: {baseline: arm({costUsd: 1}), treatment: arm({success: 7, costUsd: 1.25})},
							}),
						},
					}),
				],
			),
		);
		expect(verdict._tag).toBe("Clean");
	});
});

describe("judge — provenance: the trusted runner, the content it measured", () => {
	it("answers UNKNOWN when no token is present — never clean", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {provenance: {...goodProvenance, tokenPresent: false, run: null}})],
			),
		);
		expect(verdict._tag).toBe("Unknown");
		expect(verdict._tag === "Unknown" && verdict.report).toContain(
			"cannot verify provenance without GITHUB_TOKEN",
		);
	});

	it("answers UNKNOWN when the API could not be read at all", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {provenance: {...goodProvenance, run: null}})],
			),
		);
		expect(verdict._tag === "Unknown" && verdict.report).toContain(
			"the GitHub API could not be read",
		);
	});

	it("answers UNKNOWN when the run id does not resolve (404)", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {provenance: {...goodProvenance, run: {exists: false}}})],
			),
		);
		expect(verdict._tag === "Unknown" && verdict.report).toContain(
			"was not found among the repository's workflow runs",
		);
	});

	it.each([
		["a run of another workflow", {path: ".github/workflows/other.yml"}],
		["an incomplete run", {status: "in_progress"}],
		["a failed run", {conclusion: "failure"}],
		["a run at another commit", {headSha: TREE_OTHER}],
	])("reds evidence from %s", (_name, over) => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {provenance: {...goodProvenance, run: {...goodRun, ...over}}})],
			),
		);
		const violation = isViolation(verdict);
		expect(violation?.report).toContain("evidence did not come from the trusted runner");
		expect(violation?.report).toContain("expected");
	});

	it("answers UNKNOWN when the benchmark commit is absent from the checkout", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[
					skill("build", {
						provenance: {...goodProvenance, reachable: false, benchmarkTreeAtHeadSha: null},
					}),
				],
			),
		);
		expect(verdict._tag === "Unknown" && verdict.report).toContain("cannot bind content");
	});

	it("reds a trusted run that measured different content than the report attests", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[skill("build", {provenance: {...goodProvenance, benchmarkTreeAtHeadSha: TREE_OTHER}})],
			),
		);
		const violation = isViolation(verdict);
		expect(violation?.report).toContain("the trusted run measured different skill content");
	});

	it("a proven red beats an unprovable provenance — the gate blocks either way", () => {
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`],
				[
					skill("build", {
						report: {_tag: "ReadError", reason: "missing"},
						provenance: {...goodProvenance, tokenPresent: false, run: null},
					}),
				],
			),
		);
		expect(verdict._tag).toBe("Violation");
	});
});

describe("judge — the happy paths", () => {
	it("PASSES a fully-evidenced NEW skill, with the scanned count in the summary", () => {
		const verdict = judge(facts([`${SKILLS}/build/SKILL.md`], [skill("build")]));
		expect(verdict._tag).toBe("Clean");
		expect(verdict._tag === "Clean" && verdict.summary).toContain("1 skill(s) checked");
		expect(verdict._tag === "Clean" && verdict.summary).toContain(
			"trusted, version-bound benchmark evidence",
		);
		expect(verdict._tag === "Clean" && verdict.scanned).toBe(1);
	});

	it("PASSES a mixed PR: one gated skill evidenced, one typo-exempt, one removed", () => {
		const exempt = skill("report", {
			typo: {nonMdFiles: [], mdFiles: 1, changedWords: 2, pairs: [{old: "teh", new: "the"}]},
			report: {_tag: "ReadError", reason: "missing"},
		});
		const gone = skill("old", {
			existsAtHead: false,
			headTreeSha: null,
			report: {_tag: "ReadError", reason: "missing"},
		});
		const verdict = judge(
			facts(
				[`${SKILLS}/build/SKILL.md`, `${SKILLS}/report/SKILL.md`, `${SKILLS}/old/SKILL.md`],
				[skill("build"), exempt, gone],
			),
		);
		expect(verdict._tag).toBe("Clean");
		expect(verdict._tag === "Clean" && verdict.summary).toContain("(1 removed, 1 typo-exempt)");
	});

	it("SKIPS when every changed skill is exempt or removed — no evidence required", () => {
		const exempt = skill("report", {
			typo: {nonMdFiles: [], mdFiles: 1, changedWords: 2, pairs: [{old: "teh", new: "the"}]},
			report: {_tag: "ReadError", reason: "missing"},
		});
		const verdict = judge(facts([`${SKILLS}/report/SKILL.md`], [exempt]));
		expect(verdict._tag).toBe("Skipped");
	});
});

describe("parsePolicy", () => {
	const policyText = JSON.stringify({
		producerWorkflow: PRODUCER,
		skillsRoot: SKILLS,
		reportRoot: REPORTS,
		thresholds: {default: DEFAULTS, perSkill: {build: {minRepetitions: 1}}},
		typoExemption: {mdOnly: true, maxChangedWords: 20, maxWordEditDistance: 2},
	});

	it("parses a well-formed policy with its per-skill overrides", () => {
		const parsed = parsePolicy(policyText);
		expect(parsed._tag).toBe("Ok");
		expect(parsed._tag === "Ok" && parsed.policy.thresholds.perSkill.build).toEqual({
			minRepetitions: 1,
		});
	});

	it("PARSES an override naming unknown keys — the judge, not the parse, reds that for the skill it names", () => {
		const parsed = parsePolicy(
			JSON.stringify({
				...JSON.parse(policyText),
				thresholds: {default: DEFAULTS, perSkill: {build: {maxCostRatiox: 2}}},
			}),
		);
		expect(parsed._tag).toBe("Ok");
	});

	it("refuses malformed JSON, an unknown top-level key, a wrong-typed cap, and a wrong-typed override value alike", () => {
		expect(parsePolicy("{nope")._tag).toBe("Err");
		expect(parsePolicy(JSON.stringify({...JSON.parse(policyText), surprise: 1}))._tag).toBe("Err");
		expect(
			parsePolicy(
				JSON.stringify({
					...JSON.parse(policyText),
					typoExemption: {mdOnly: true, maxChangedWords: 0, maxWordEditDistance: 2},
				}),
			)._tag,
		).toBe("Err");
		expect(
			parsePolicy(
				JSON.stringify({
					...JSON.parse(policyText),
					thresholds: {default: DEFAULTS, perSkill: {build: {minRepetitions: "three"}}},
				}),
			)._tag,
		).toBe("Err");
	});
});

describe("validateReport", () => {
	it("accepts the canonical report and returns it typed", () => {
		const validated = validateReport(reportValue("build"));
		expect(validated._tag).toBe("Ok");
		expect(validated._tag === "Ok" && validated.report.skill.name).toBe("build");
	});
});

describe("the typo lane's word arithmetic", () => {
	it("diffWords: an identical text changes nothing", () => {
		expect(diffWords("one two three", "one two three")).toEqual({changedWords: 0, pairs: []});
	});

	it("diffWords: a one-word typo is one pair and two changed words", () => {
		const diff = diffWords("we recieve it", "we receive it");
		expect(diff.changedWords).toBe(2);
		expect(diff.pairs).toEqual([{old: "recieve", new: "receive"}]);
	});

	it("diffWords: an inserted word pairs against the empty string — its distance is its length", () => {
		const diff = diffWords("one two", "one brand-new two");
		expect(diff.pairs).toContainEqual({old: "", new: "brand-new"});
	});

	it("diffWords: a whole added file counts every word, so only a tiny file can stay exempt", () => {
		const diff = diffWords("", "a b c d e");
		expect(diff.changedWords).toBe(5);
	});

	it("diffWords: a file past the diff cap reports the full word count, never zero", () => {
		const big = Array.from({length: 2500}, (_, i) => `w${i}`).join(" ");
		expect(diffWords(big, `${big} tail`).changedWords).toBe(2500 + 2501);
	});

	it("editDistance: the Levenshtein floor cases", () => {
		expect(editDistance("same", "same")).toBe(0);
		expect(editDistance("abc", "abcdef")).toBe(3);
		expect(editDistance("", "word")).toBe(4);
	});

	it("groupSkillFiles: groups by skill dir, normalizes separators, drops non-skill files", () => {
		const grouped = groupSkillFiles(
			[
				`${SKILLS}/build/SKILL.md`,
				`${SKILLS}\\build\\scripts\\run.py`,
				"README.md",
				`${SKILLS}/report/SKILL.md`,
			],
			SKILLS,
		);
		expect(grouped).toEqual([
			["build", [`${SKILLS}/build/SKILL.md`, `${SKILLS}/build/scripts/run.py`]],
			["report", [`${SKILLS}/report/SKILL.md`]],
		]);
	});
});
