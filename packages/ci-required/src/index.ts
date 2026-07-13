/** `@kampus/ci-required` — public surface of the pure `ci-required` CI-aggregator verdict core (see `ci-required.ts`; issue #786, ADR 0092). */
export {
	type CiRequiredInput,
	type CiRequiredVerdict,
	inputFromEnv,
	type JobInput,
	type JobReport,
	type JobResult,
	type JobVerdict,
	judge,
	judgeJob,
} from "./ci-required.ts";
