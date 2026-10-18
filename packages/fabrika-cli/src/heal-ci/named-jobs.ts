/**
 * The jobs a failing required roll-up names, tied to the workflow jobs that ran them.
 *
 * A roll-up context restates other jobs' verdicts, and those jobs block only through it: none of
 * them is required by its own name. Its `FAIL` lines name each one by **workflow job key**
 * (`../ci/required.ts` owns that grammar), while a check run and a workflow job carry the
 * **display name**. The two differ wherever a job declares `name:`, so the tie is read from the
 * workflow file the roll-up's own run executed, at the head it ran on, and nothing else:
 *
 * - no `name:` → the display name is the key itself, as GitHub names such a job;
 * - a literal `name:` → that string;
 * - a `name:` carrying an expression, a `strategy.matrix`, or a reusable-workflow `uses:` → no tie,
 *   because the platform composes that display name at run time and reproducing it here is a guess.
 *
 * A tied name must then match exactly one job of the roll-up's own workflow run. A key that fails
 * any step is returned untied, with the reason, and no other job's log stands in for it.
 *
 * Which context is a roll-up is never a name this module knows: a failing required context whose
 * log carries `FAIL` lines is one, whatever the repository calls it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10432#issuecomment-5983093271
 */
import {Effect, Option} from "effect";
import {parse} from "yaml";
import {failedJobKeys} from "../ci/required.ts";
import type {Shell} from "../io/git.ts";
import {isRecord} from "../io/json.ts";
import type {RollupReach, UntiedKey} from "../review/blocking.ts";
import {
	listRunsAtHead,
	readFileAtRef,
	type ShipCheckRun,
	type WorkflowRun,
} from "../ship/github.ts";
import {fetchJobLog, listRunJobs, type WorkflowJob} from "./github.ts";

/** What a job key's display name is, read off a parsed workflow document. */
export type DisplayName =
	| {readonly _tag: "Named"; readonly name: string}
	| {readonly _tag: "Untied"; readonly reason: string};

/** The display name GitHub gives job `key` of `workflow`, or why it cannot be read statically. */
export const displayNameOf = (workflow: unknown, key: string): DisplayName => {
	const jobs = isRecord(workflow) ? workflow.jobs : undefined;
	const job = isRecord(jobs) ? jobs[key] : undefined;
	if (!isRecord(job)) {
		return {_tag: "Untied", reason: "the workflow file declares no job by that key"};
	}
	if (job.uses !== undefined) {
		return {
			_tag: "Untied",
			reason: "it calls a reusable workflow, whose check runs carry a composed name",
		};
	}
	if (isRecord(job.strategy) && job.strategy.matrix !== undefined) {
		return {_tag: "Untied", reason: "it is a matrix job, whose check runs carry a composed name"};
	}
	if (job.name === undefined) return {_tag: "Named", name: key};
	if (typeof job.name !== "string" || job.name.trim() === "") {
		return {_tag: "Untied", reason: "its name: is not a string"};
	}
	if (job.name.includes("${{")) {
		return {_tag: "Untied", reason: "its name: is an expression evaluated at run time"};
	}
	return {_tag: "Named", name: job.name};
};

/** A key a roll-up named, tied to the one job of its run that carries the display name. */
export interface TiedJob {
	readonly key: string;
	readonly job: WorkflowJob;
}

/** A key a roll-up named that could not be tied, and why. */
export interface UntiedJob {
	readonly key: string;
	readonly reason: string;
}

export type NamedJobs =
	| {
			readonly _tag: "Read";
			readonly tied: ReadonlyArray<TiedJob>;
			readonly untied: ReadonlyArray<UntiedJob>;
	  }
	/** A read on the tie's path failed — which job the roll-up names is UNKNOWN, never none. */
	| {readonly _tag: "Unknown"; readonly what: string; readonly reason: string}
	/** The run's job enumeration is provably short of its declared count. */
	| {readonly _tag: "Incomplete"; readonly received: number; readonly declared: number};

const allUntied = (keys: ReadonlyArray<string>, reason: string): NamedJobs => ({
	_tag: "Read",
	tied: [],
	untied: keys.map((key) => ({key, reason})),
});

/** Ties each key to exactly one job of `jobs`, by the display name `workflow` gives it. */
export const tieKeys = (
	keys: ReadonlyArray<string>,
	workflow: unknown,
	jobs: ReadonlyArray<WorkflowJob>,
): {readonly tied: ReadonlyArray<TiedJob>; readonly untied: ReadonlyArray<UntiedJob>} => {
	const tied: TiedJob[] = [];
	const untied: UntiedJob[] = [];
	for (const key of keys) {
		const display = displayNameOf(workflow, key);
		if (display._tag === "Untied") {
			untied.push({key, reason: display.reason});
			continue;
		}
		const matches = jobs.filter((job) => job.name === display.name);
		const [only] = matches;
		if (matches.length === 1 && only !== undefined) {
			tied.push({key, job: only});
			continue;
		}
		untied.push({
			key,
			reason:
				matches.length === 0
					? `no job named "${display.name}" ran in the roll-up's workflow run`
					: `${matches.length} jobs named "${display.name}" ran in the roll-up's workflow run`,
		});
	}
	return {tied, untied};
};

/**
 * The jobs one failing roll-up context names in `log`, tied through its own run's workflow file.
 *
 * `runs` are the workflow runs at the head; the roll-up's run is the one that published its check
 * suite. A log naming no job is a context that is no roll-up, answered with nothing to follow.
 */
export const namedJobsOf = (
	repo: string,
	sha: string,
	rollup: ShipCheckRun,
	log: string,
	runs: ReadonlyArray<WorkflowRun>,
): Shell<NamedJobs> =>
	Effect.gen(function* () {
		const keys = failedJobKeys(log);
		if (keys.length === 0) return {_tag: "Read" as const, tied: [], untied: []};

		const run = runs.find((candidate) => candidate.checkSuiteId === rollup.checkSuiteId);
		if (run === undefined || run.path === "") {
			return allUntied(keys, `no workflow run at this head published ${rollup.name}`);
		}

		const file = yield* readFileAtRef(repo, run.path, sha);
		if (file._tag === "Unknown") {
			return {_tag: "Unknown" as const, what: `${run.path} at ${sha}`, reason: file.reason};
		}
		if (file._tag === "Absent") return allUntied(keys, `${run.path} is absent at ${sha}`);
		const workflow = yield* Effect.option(
			Effect.try({try: (): unknown => parse(file.value), catch: () => "unparseable"}),
		);
		if (Option.isNone(workflow)) {
			return allUntied(keys, `${run.path} does not parse as YAML at ${sha}`);
		}

		const jobs = yield* listRunJobs(repo, run.id);
		if (jobs._tag === "Failure") {
			return {_tag: "Unknown" as const, what: `run ${run.id}'s jobs`, reason: jobs.reason};
		}
		if (jobs.value.jobs.length < jobs.value.declared) {
			return {
				_tag: "Incomplete" as const,
				received: jobs.value.jobs.length,
				declared: jobs.value.declared,
			};
		}
		return {_tag: "Read" as const, ...tieKeys(keys, workflow.value, jobs.value.jobs)};
	});

/** Whether a tied job concluded in a way that left a failure log to read. */
export const isFailedJob = (job: WorkflowJob): boolean =>
	job.status === "completed" &&
	job.conclusion !== null &&
	!["success", "skipped", "neutral"].includes(job.conclusion);

/** The stderr line one untied key earns, single-sourced so `logs` and `diagnose` say one thing. */
export const untiedLine = (verb: string, rollup: string, untied: UntiedJob): string =>
	`${verb}: ${rollup} names job ${untied.key}, which cannot be tied to a check run: ${untied.reason} — no log is read in its place.`;

/**
 * Which failing check runs outside the required set each failing required context names — the read
 * `diagnose` takes to say a red blocks through a roll-up rather than never.
 *
 * `logs` does not call this: it already holds every failing required context's log, and follows each
 * one through {@link namedJobsOf} as it goes. Any read on this path that fails answers `Unknown`,
 * because a red it could not rule out is not provably "never blocking" either.
 */
export const rollupReach = (
	verb: string,
	repo: string,
	sha: string,
	failingRequired: ReadonlyArray<ShipCheckRun>,
	blocks: (name: string) => boolean,
): Shell<{readonly reach: RollupReach; readonly notices: ReadonlyArray<string>}> =>
	Effect.gen(function* () {
		const notices: string[] = [];
		const through = new Map<string, string>();
		const untiedKeys: UntiedKey[] = [];
		const unknown = (reason: string) => ({
			reach: {_tag: "Unknown" as const, reason},
			notices,
		});
		if (failingRequired.length === 0) {
			return {reach: {_tag: "Read" as const, through, untied: untiedKeys}, notices};
		}

		const runs = yield* listRunsAtHead(repo, sha);
		if (runs._tag === "Failure") return unknown(`the run list could not be read: ${runs.reason}`);
		if (runs.value.runs.length < runs.value.declared) {
			return unknown(
				`received ${runs.value.runs.length} of ${runs.value.declared} declared workflow runs`,
			);
		}

		for (const rollup of failingRequired) {
			const run = runs.value.runs.find(
				(candidate) => candidate.checkSuiteId === rollup.checkSuiteId,
			);
			// A context no workflow run published is an external check, which has no log to name a job.
			if (run === undefined) continue;
			const jobs = yield* listRunJobs(repo, run.id);
			if (jobs._tag === "Failure") return unknown(`run ${run.id}'s jobs: ${jobs.reason}`);
			if (jobs.value.jobs.length < jobs.value.declared) {
				return unknown(
					`received ${jobs.value.jobs.length} of ${jobs.value.declared} declared jobs of run ${run.id}`,
				);
			}
			const own = jobs.value.jobs.filter((job) => job.name === rollup.name);
			const [job] = own;
			if (own.length !== 1 || job === undefined) {
				return unknown(`${own.length} jobs of run ${run.id} are named ${rollup.name}`);
			}
			const log = yield* fetchJobLog(repo, job.id);
			if (log._tag === "Expired") return unknown(`${rollup.name}'s log is expired`);
			if (log._tag === "Failed") return unknown(`${rollup.name}'s log: ${log.reason}`);

			const named = yield* namedJobsOf(repo, sha, rollup, log.text, runs.value.runs);
			if (named._tag === "Unknown") return unknown(`${named.what}: ${named.reason}`);
			if (named._tag === "Incomplete") {
				return unknown(`received ${named.received} of ${named.declared} declared jobs`);
			}
			for (const untied of named.untied) {
				notices.push(untiedLine(verb, rollup.name, untied));
				untiedKeys.push({rollup: rollup.name, key: untied.key});
			}
			for (const tied of named.tied) {
				if (!blocks(tied.job.name) && isFailedJob(tied.job)) {
					through.set(tied.job.name, rollup.name);
				}
			}
		}
		return {reach: {_tag: "Read" as const, through, untied: untiedKeys}, notices};
	});
