import {assert, describe, it} from "@effect/vitest";
import {
	type CiRequiredInput,
	inputFromEnv,
	type JobResult,
	judge,
	judgeJob,
} from "./ci-required.ts";

/** A non-changes gating job's verdict, by name, from a whole-aggregator input. */
const verdictOf = (input: CiRequiredInput, name: string) =>
	judge(input).jobs.find((j) => j.name === name)?.verdict;

/** The gating jobs with `check`/`unit` sharing `check_required`. */
const env = (over: Record<string, string>): Record<string, string> => ({
	CHANGES_RESULT: "success",
	CHECK_REQUIRED: "false",
	PACKAGES_REQUIRED: "false",
	WORKFLOWS_REQUIRED: "false",
	INTEGRATION_REQUIRED: "false",
	E2E_REQUIRED: "false",
	CHECK_RESULT: "skipped",
	UNIT_RESULT: "skipped",
	PACKAGES_RESULT: "skipped",
	ACTIONLINT_RESULT: "skipped",
	INTEGRATION_RESULT: "skipped",
	E2E_RESULT: "skipped",
	...over,
});

describe("judgeJob — per-job verdict (required ⇒ must succeed; not-required skip is legit)", () => {
	it("required + success → required-pass", () => {
		const r = judgeJob({name: "integration", required: true, result: "success"});
		assert.strictEqual(r.verdict, "required-pass");
	});

	it("required + skipped → FAIL (the should-have-run silent-no-op, ADR 0092)", () => {
		const r = judgeJob({name: "integration", required: true, result: "skipped"});
		assert.strictEqual(r.verdict, "FAIL");
	});

	it("required + failure → FAIL (a real failure is never masked)", () => {
		const r = judgeJob({name: "check", required: true, result: "failure"});
		assert.strictEqual(r.verdict, "FAIL");
	});

	it("required + empty result → FAIL (fail-closed on an untrustworthy/empty conclusion)", () => {
		const r = judgeJob({name: "e2e", required: true, result: "" as JobResult});
		assert.strictEqual(r.verdict, "FAIL");
	});

	it("not-required + skipped → legit-skip (legitimate not-applicable PASS)", () => {
		const r = judgeJob({name: "e2e", required: false, result: "skipped"});
		assert.strictEqual(r.verdict, "legit-skip");
	});

	it("not-required + success → legit-skip (a non-required job that ran+passed is fine)", () => {
		const r = judgeJob({name: "unit", required: false, result: "success"});
		assert.strictEqual(r.verdict, "legit-skip");
	});

	it("not-required + failure → FAIL (a non-required job that actually FAILED is not waved through)", () => {
		const r = judgeJob({name: "integration", required: false, result: "failure"});
		assert.strictEqual(r.verdict, "FAIL");
	});
});

describe("judge — the 4 integration scenarios from the PR body (#782/#786)", () => {
	// integration_required = (backend || feature-complete) && (push || author-allowed)

	it("Scenario 1: backend-changed push to main → integration required; ran+passed PASS, but a SKIP FAILs", () => {
		// ran + passed
		assert.isTrue(
			judge(inputFromEnv(env({INTEGRATION_REQUIRED: "true", INTEGRATION_RESULT: "success"}))).pass,
		);
		// the silent-no-op: required but skipped ⇒ FAIL
		const skipped = judge(
			inputFromEnv(env({INTEGRATION_REQUIRED: "true", INTEGRATION_RESULT: "skipped"})),
		);
		assert.isFalse(skipped.pass);
		assert.strictEqual(skipped.jobs.find((j) => j.name === "integration")?.verdict, "FAIL");
	});

	it("Scenario 2: backend-changed PR, author allowed → integration required; skip FAILs", () => {
		const e = env({INTEGRATION_REQUIRED: "true", INTEGRATION_RESULT: "skipped"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "integration"), "FAIL");
		assert.isFalse(judge(inputFromEnv(e)).pass);
	});

	it("Scenario 3: feature-complete-labelled PR (backend=false), author allowed → integration required; skip FAILs", () => {
		const e = env({INTEGRATION_REQUIRED: "true", INTEGRATION_RESULT: "skipped"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "integration"), "FAIL");
		assert.isFalse(judge(inputFromEnv(e)).pass);
	});

	it("Scenario 4: non-backend, non-flagged PR → integration NOT required; skip is a legit-skip PASS", () => {
		const e = env({INTEGRATION_REQUIRED: "false", INTEGRATION_RESULT: "skipped"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "integration"), "legit-skip");
		assert.isTrue(judge(inputFromEnv(e)).pass);
	});
});

describe("judge — packages-tests (#760): packages/** change required, others legit-skip", () => {
	// packages_required = (packages path filter matched) — no fork/author guard.

	it("packages-changed PR → packages-tests required; ran+passed PASS", () => {
		const e = env({PACKAGES_REQUIRED: "true", PACKAGES_RESULT: "success"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "packages-tests"), "required-pass");
		assert.isTrue(judge(inputFromEnv(e)).pass);
	});

	it("packages-changed PR but suites SKIPPED → FAIL (the should-have-run silent-no-op, ADR 0092)", () => {
		const e = env({PACKAGES_REQUIRED: "true", PACKAGES_RESULT: "skipped"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "packages-tests"), "FAIL");
		assert.isFalse(judge(inputFromEnv(e)).pass);
	});

	it("packages-changed PR with a FAILING guard test → overall FAIL (a real failure is never masked)", () => {
		const e = env({PACKAGES_REQUIRED: "true", PACKAGES_RESULT: "failure"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "packages-tests"), "FAIL");
		assert.isFalse(judge(inputFromEnv(e)).pass);
	});

	it("non-packages PR → packages-tests NOT required; skip is a legit-skip PASS", () => {
		const e = env({PACKAGES_REQUIRED: "false", PACKAGES_RESULT: "skipped"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "packages-tests"), "legit-skip");
		assert.isTrue(judge(inputFromEnv(e)).pass);
	});

	it("changes source job failed → packages-tests required-ness untrustworthy ⇒ fail closed", () => {
		const e = env({
			CHANGES_RESULT: "failure",
			PACKAGES_REQUIRED: "",
			PACKAGES_RESULT: "skipped",
		});
		const v = judge(inputFromEnv(e));
		assert.isFalse(v.pass);
		assert.isNotNull(v.changesReport);
	});
});

describe("judge — actionlint (#568): workflow change required, non-workflow PR legit-skip", () => {
	// workflows_required = (the `workflows` path filter only — creds-free, no author/fork guard)

	it("workflow-changed PR → actionlint required; ran+passed PASS", () => {
		const e = env({WORKFLOWS_REQUIRED: "true", ACTIONLINT_RESULT: "success"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "actionlint"), "required-pass");
		assert.isTrue(judge(inputFromEnv(e)).pass);
	});

	it("workflow-changed PR but actionlint SKIPPED → FAIL (the should-have-run silent-no-op, ADR 0092)", () => {
		const e = env({WORKFLOWS_REQUIRED: "true", ACTIONLINT_RESULT: "skipped"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "actionlint"), "FAIL");
		assert.isFalse(judge(inputFromEnv(e)).pass);
	});

	it("malformed workflow → actionlint FAILED → overall FAIL (a real failure is never masked)", () => {
		const e = env({WORKFLOWS_REQUIRED: "true", ACTIONLINT_RESULT: "failure"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "actionlint"), "FAIL");
		assert.isFalse(judge(inputFromEnv(e)).pass);
	});

	it("non-workflow PR → actionlint NOT required; skip is a legit-skip PASS", () => {
		const e = env({WORKFLOWS_REQUIRED: "false", ACTIONLINT_RESULT: "skipped"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "actionlint"), "legit-skip");
		assert.isTrue(judge(inputFromEnv(e)).pass);
	});

	it("changes source job failed → workflows_required untrustworthy ⇒ overall fail closed", () => {
		const e = env({
			CHANGES_RESULT: "failure",
			WORKFLOWS_REQUIRED: "",
			ACTIONLINT_RESULT: "skipped",
		});
		const v = judge(inputFromEnv(e));
		assert.isFalse(v.pass);
		assert.isNotNull(v.changesReport);
	});
});

describe("judge — fork / non-author PR (the secret-less skip stays legitimate, never FAIL)", () => {
	it("fork PR: integration_required=false && e2e_required=false ⇒ both skips are legit-skip PASS", () => {
		const e = env({
			// code-only frontend change, but author guard false → no secrets → both skip
			INTEGRATION_REQUIRED: "false",
			E2E_REQUIRED: "false",
			INTEGRATION_RESULT: "skipped",
			E2E_RESULT: "skipped",
		});
		const v = judge(inputFromEnv(e));
		assert.strictEqual(verdictOf(inputFromEnv(e), "integration"), "legit-skip");
		assert.strictEqual(verdictOf(inputFromEnv(e), "e2e"), "legit-skip");
		assert.isTrue(v.pass);
	});
});

describe("judge — a genuine job FAILURE is a FAIL, never masked as a skip", () => {
	it("required check that actually FAILED → overall FAIL", () => {
		const e = env({CHECK_REQUIRED: "true", CHECK_RESULT: "failure", UNIT_RESULT: "success"});
		const v = judge(inputFromEnv(e));
		assert.strictEqual(verdictOf(inputFromEnv(e), "check"), "FAIL");
		assert.isFalse(v.pass);
	});

	it("required unit that was cancelled → overall FAIL (cancelled is non-success)", () => {
		const e = env({CHECK_REQUIRED: "true", CHECK_RESULT: "success", UNIT_RESULT: "cancelled"});
		assert.isFalse(judge(inputFromEnv(e)).pass);
		assert.strictEqual(verdictOf(inputFromEnv(e), "unit"), "FAIL");
	});
});

describe("judge — the changes source job itself failed → fail closed", () => {
	it("changes result != success → overall FAIL even if every gating job 'looks' skipped", () => {
		const e = env({
			CHANGES_RESULT: "failure",
			// outputs would be empty/untrustworthy; everything reads skipped
			CHECK_REQUIRED: "",
			INTEGRATION_REQUIRED: "",
			E2E_REQUIRED: "",
		});
		const v = judge(inputFromEnv(e));
		assert.isFalse(v.pass);
		assert.isNotNull(v.changesReport);
		assert.strictEqual(v.changesReport?.verdict, "FAIL");
	});

	it("changes was itself skipped (unmet upstream) → fail closed", () => {
		const v = judge(inputFromEnv(env({CHANGES_RESULT: "skipped"})));
		assert.isFalse(v.pass);
		assert.isNotNull(v.changesReport);
	});
});

describe("judge — the all-clean happy paths PASS", () => {
	it("everything required and successful → PASS", () => {
		const e = env({
			CHECK_REQUIRED: "true",
			PACKAGES_REQUIRED: "true",
			WORKFLOWS_REQUIRED: "true",
			INTEGRATION_REQUIRED: "true",
			E2E_REQUIRED: "true",
			CHECK_RESULT: "success",
			UNIT_RESULT: "success",
			PACKAGES_RESULT: "success",
			ACTIONLINT_RESULT: "success",
			INTEGRATION_RESULT: "success",
			E2E_RESULT: "success",
		});
		assert.isTrue(judge(inputFromEnv(e)).pass);
	});

	it("docs/skills-only PR: nothing required, everything skipped → PASS (all legit-skip)", () => {
		const v = judge(inputFromEnv(env({})));
		assert.isTrue(v.pass);
		assert.isTrue(v.jobs.every((j) => j.verdict === "legit-skip"));
		assert.isNull(v.changesReport);
	});
});

describe("judge — packages-tests gate (#760): packages_required required/legit-skip/fail", () => {
	// packages_required = (the `packages` path filter only — creds-free, no author/fork guard)

	it("packages changed → packages-tests required; ran+passed PASS", () => {
		const e = env({PACKAGES_REQUIRED: "true", PACKAGES_RESULT: "success"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "packages-tests"), "required-pass");
		assert.isTrue(judge(inputFromEnv(e)).pass);
	});

	it("packages changed but a guard test FAILED → packages-tests FAIL → overall FAIL", () => {
		const e = env({PACKAGES_REQUIRED: "true", PACKAGES_RESULT: "failure"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "packages-tests"), "FAIL");
		assert.isFalse(judge(inputFromEnv(e)).pass);
	});

	it("packages required but skipped → FAIL (the should-have-run silent-no-op, ADR 0092)", () => {
		const e = env({PACKAGES_REQUIRED: "true", PACKAGES_RESULT: "skipped"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "packages-tests"), "FAIL");
		assert.isFalse(judge(inputFromEnv(e)).pass);
	});

	it("non-packages PR → packages-tests NOT required; skip is a legit-skip PASS", () => {
		const e = env({PACKAGES_REQUIRED: "false", PACKAGES_RESULT: "skipped"});
		assert.strictEqual(verdictOf(inputFromEnv(e), "packages-tests"), "legit-skip");
		assert.isTrue(judge(inputFromEnv(e)).pass);
	});

	it("changes source job failed → packages_required untrustworthy ⇒ overall fail closed", () => {
		const e = env({CHANGES_RESULT: "failure", PACKAGES_REQUIRED: "", PACKAGES_RESULT: "skipped"});
		const v = judge(inputFromEnv(e));
		assert.isFalse(v.pass);
		assert.isNotNull(v.changesReport);
	});
});

describe("inputFromEnv — env mapping (check & unit share check_required; missing ⇒ false/empty)", () => {
	it("check and unit both read CHECK_REQUIRED", () => {
		const input = inputFromEnv(env({CHECK_REQUIRED: "true"}));
		assert.isTrue(input.jobs.find((j) => j.name === "check")?.required);
		assert.isTrue(input.jobs.find((j) => j.name === "unit")?.required);
	});

	it("packages-tests reads its own PACKAGES_REQUIRED (not check_required)", () => {
		const input = inputFromEnv(env({CHECK_REQUIRED: "false", PACKAGES_REQUIRED: "true"}));
		assert.isTrue(input.jobs.find((j) => j.name === "packages-tests")?.required);
		assert.isFalse(input.jobs.find((j) => j.name === "check")?.required);
	});

	it("actionlint reads its own WORKFLOWS_REQUIRED (not check_required)", () => {
		const input = inputFromEnv(env({CHECK_REQUIRED: "false", WORKFLOWS_REQUIRED: "true"}));
		assert.isTrue(input.jobs.find((j) => j.name === "actionlint")?.required);
		assert.isFalse(input.jobs.find((j) => j.name === "check")?.required);
	});

	it("only the literal 'true' is required; 'TRUE'/'1'/'' are false (fail-closed default)", () => {
		const input = inputFromEnv({
			INTEGRATION_REQUIRED: "TRUE",
			E2E_REQUIRED: "1",
		});
		assert.isFalse(input.jobs.find((j) => j.name === "integration")?.required);
		assert.isFalse(input.jobs.find((j) => j.name === "e2e")?.required);
		assert.isFalse(input.jobs.find((j) => j.name === "check")?.required);
	});

	it("a missing CHANGES_RESULT reads as empty ⇒ fail closed", () => {
		assert.isFalse(judge(inputFromEnv({})).pass);
	});
});
