/**
 * `@kampus/ci-required` — the pure verdict for the `ci-required` CI aggregator
 * (issue #786, ADR 0092). The core (`judge`/`judgeJob`/`inputFromEnv`) is a pure,
 * IO-free, zero-runtime-dependency matcher; `bin.ts` is the thin Node shell that
 * reads the gate job's `env:` and exits 0/1. This replaces the untested inline
 * bash assertion loop in `.github/workflows/ci.yml`.
 */
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
