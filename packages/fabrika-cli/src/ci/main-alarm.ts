/**
 * Main-alarm core — the pure, IO-free decision behind a workflow reporting its own red: a push to
 * the default branch went red, so open one tracking issue or comment on the one already open; on
 * the next green, close it.
 *
 * A workflow that only runs after merge reports to nobody. Its red is a check mark on a commit, and
 * a commit nobody is looking at carries it silently for as long as it takes someone to ask why the
 * branch is red. `deploy.yml` failed on 8 consecutive main pushes over 3 days that way, and
 * `release-please.yml` on twelve. The hook is the workflow reporting itself, and what makes it
 * bearable is that a run of reds produces ONE issue and a comment each, never one issue per run.
 *
 * **Nothing here is about deploys.** The input is a run result and the open alarm issues; the
 * output is which single write this run owes. Any workflow that only runs post-merge can call it.
 *
 * **Dedup is on a body marker plus the configured label, never on title text.** A title is prose
 * someone edits; {@link alarmMarker} is an HTML comment nothing renders and nothing rewrites, and
 * the label narrows the lookup to a handful of issues before the marker decides. The marker carries
 * the workflow's own key, so `deploy.yml` and `release-please.yml` keep separate alarms rather than
 * fighting over one. The lookup is author-constrained on top, so a human issue quoting the marker
 * can never be commented on or closed by this path.
 *
 * **No `effect` import, here or in `main-alarm-bin.ts`.** This pair is a bare bin rather than a
 * registered `fabrika ci …` verb for the reason `required.ts` is: the job that runs it is a
 * notification path, so it must not depend on the install that may be exactly what broke. Checkout
 * + setup-node + node, no `pnpm install` — the module graph is relative plain-TS imports the
 * runtime type-strips, and the config half reaches no further than `config/document.ts`.
 *
 * No IO: `main-alarm-bin.ts` reads the run's facts and the candidate issues and performs the write;
 * this decides which write it is and what it says.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9508
 */

/** Intake's own entry label — the alarm lands as an ordinary report and is triaged like one. */
export const TRIAGE_LABEL = "status:needs-triage";

/**
 * The author an alarm issue must carry.
 *
 * This is GitHub's own default-token identity, byte-identical in every repository on the platform,
 * which is why it is a constant rather than a config key: it names no person, org or repo. Anything
 * else carrying the marker is a human's issue that merely quotes it.
 */
export const ACTIONS_BOT = "github-actions[bot]";

/**
 * The HTML-comment key that makes an issue this workflow's alarm.
 *
 * Keyed on the workflow, not the repo: two post-merge workflows both calling this bin must not
 * close each other's alarms, and a single shared marker is exactly how they would.
 */
export const alarmMarker = (workflowKey: string): string =>
	`<!-- fabrika-main-alarm workflow=${workflowKey} -->`;

/**
 * The stable per-workflow dedup key, off the environment GitHub sets on every run.
 *
 * `GITHUB_WORKFLOW_REF` is the workflow's own file path
 * (`owner/repo/.github/workflows/deploy.yml@refs/heads/main`), so the key survives a rename of the
 * workflow's display name — the display name is prose and someone will edit it, and an alarm whose
 * key moved leaves the standing issue orphaned and opens a second one. Where that variable is
 * absent the display name is the fallback, slugged so the marker stays one token.
 */
export const workflowKeyFromEnv = (env: Record<string, string | undefined>): string => {
	const ref = (env.GITHUB_WORKFLOW_REF ?? "").trim();
	const path = ref.split("@")[0] ?? "";
	const file = path.slice(path.lastIndexOf("/") + 1);
	if (file !== "") return file;
	const slug = (env.GITHUB_WORKFLOW ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug === "" ? "unnamed-workflow" : slug;
};

/** One open issue as the lookup saw it — the only fields the selection reads. */
export interface IssueCandidate {
	readonly number: number;
	readonly body: string | null;
	readonly authorLogin: string | null;
	readonly authorType: string | null;
}

/** What the run knows about itself, as the workflow's own context hands it over. */
export interface RunFacts {
	/** The workflow's display name, so the issue says which workflow went red. */
	readonly workflow: string;
	/** The dedup key {@link alarmMarker} is built from — one alarm per workflow. */
	readonly workflowKey: string;
	/** The run's own URL — the one link that leads to every log. */
	readonly runUrl: string;
	/** The head commit the run built. */
	readonly headSha: string;
	/** The branch the push landed on. */
	readonly branch: string;
	/**
	 * The names of the jobs that concluded `failure` in this run, as the run's job list reported
	 * them. Empty is ambiguous on its own, which is why {@link RunFacts.jobsRead} exists.
	 */
	readonly failedJobs: ReadonlyArray<string>;
	/**
	 * Was the run's job list read at all? `false` means the API call failed, so an empty
	 * `failedJobs` says nothing — the issue is still filed, and it says the list was unreadable
	 * rather than claiming no job failed.
	 */
	readonly jobsRead: boolean;
	/**
	 * The handles to `@`-mention, so GitHub's own notifications deliver the ping. Empty omits the
	 * mention line: who to wake is the calling repository's fact, not this module's.
	 */
	readonly mention: ReadonlyArray<string>;
}

/**
 * A job or run result as Actions words it. Closed on purpose, and {@link decodeResult} refuses
 * anything outside it rather than falling back: a misspelled `--result` silently read as `failure`
 * would open alarms on green pushes, and read as `success` would close a live one.
 */
export type RunResult = "success" | "failure" | "cancelled" | "skipped";

const RESULTS: ReadonlyArray<RunResult> = ["success", "failure", "cancelled", "skipped"];

/** The result, or `null` for a value Actions never emits. */
export const decodeResult = (raw: string): RunResult | null => {
	const value = raw.trim();
	return (RESULTS as ReadonlyArray<string>).includes(value) ? (value as RunResult) : null;
};

export type Decision =
	| {
			readonly action: "create";
			readonly title: string;
			readonly body: string;
			readonly labels: ReadonlyArray<string>;
			readonly reason: string;
	  }
	| {
			readonly action: "comment";
			readonly issue: number;
			readonly body: string;
			readonly reason: string;
	  }
	| {
			readonly action: "close";
			readonly issue: number;
			readonly comment: string;
			readonly reason: string;
	  }
	| {readonly action: "noop"; readonly reason: string};

const isAlarm = (marker: string, candidate: IssueCandidate): boolean =>
	candidate.authorLogin === ACTIONS_BOT &&
	candidate.authorType === "Bot" &&
	(candidate.body ?? "").includes(marker);

/**
 * The one alarm issue among the open candidates, or `null`.
 *
 * Lowest number wins so a board that somehow carries two is decided the same way on every run: the
 * older issue is the one with the history on it, and the younger is the duplicate a human closes.
 */
export const selectAlarm = (
	marker: string,
	candidates: ReadonlyArray<IssueCandidate>,
): IssueCandidate | null => {
	let found: IssueCandidate | null = null;
	for (const candidate of candidates) {
		if (!isAlarm(marker, candidate)) continue;
		if (found === null || candidate.number < found.number) found = candidate;
	}
	return found;
};

/** `abc1234` — enough to name the commit, short enough to read inline. */
const shortSha = (sha: string): string => (sha.length > 7 ? sha.slice(0, 7) : sha);

const jobsLine = (facts: RunFacts): string => {
	if (!facts.jobsRead) {
		return "- **Failed job:** the run's job list could not be read — open the run to see which job went red.";
	}
	if (facts.failedJobs.length === 0) {
		return "- **Failed job:** none of the run's jobs reported a `failure` conclusion — the run failed outside a job (a cancelled or unstartable job); open the run.";
	}
	const names = facts.failedJobs.map((name) => `\`${name}\``).join(", ");
	return `- **Failed job${facts.failedJobs.length > 1 ? "s" : ""}:** ${names}`;
};

const runFactLines = (facts: RunFacts): string =>
	[
		jobsLine(facts),
		`- **Run:** ${facts.runUrl}`,
		`- **Head commit:** \`${shortSha(facts.headSha)}\` (\`${facts.headSha}\`)`,
		`- **Branch:** \`${facts.branch}\``,
	].join("\n");

/** One `@handle` per declared mention, or nothing at all. The `@` is normalised, never doubled. */
const mentionLine = (facts: RunFacts): string => {
	const handles = facts.mention.map((handle) => `@${handle.replace(/^@/, "")}`);
	return handles.length === 0 ? "" : `\n\n${handles.join(" ")}`;
};

/** The alarm's title. Stable on purpose: nothing keys on it, and a run number in it would churn. */
export const alarmTitle = (facts: RunFacts): string =>
	`\`${facts.workflow}\` is failing on pushes to \`${facts.branch}\``;

export const alarmBody = (facts: RunFacts): string =>
	`${alarmMarker(facts.workflowKey)}
The \`${facts.workflow}\` workflow failed on a push to \`${facts.branch}\`. That run happens only after
merge, so no pull-request gate can catch it and nothing else reports it — this issue is the report.${mentionLine(facts)}

${runFactLines(facts)}

Every later red push-to-\`${facts.branch}\` run of this workflow comments here instead of opening a
second issue. The next green run closes this issue with a link to that run.
`;

export const repeatCommentBody = (facts: RunFacts): string =>
	`${alarmMarker(facts.workflowKey)}
Still red — \`${facts.workflow}\` failed again on a push to \`${facts.branch}\`.${mentionLine(facts)}

${runFactLines(facts)}
`;

export const recoveryCommentBody = (facts: RunFacts): string =>
	`${alarmMarker(facts.workflowKey)}
Green again — \`${facts.workflow}\` succeeded on a push to \`${facts.branch}\`, so this alarm is closed.

- **Run:** ${facts.runUrl}
- **Head commit:** \`${shortSha(facts.headSha)}\` (\`${facts.headSha}\`)

A later red push-to-\`${facts.branch}\` run opens a fresh alarm.
`;

/** What one run hands the decision: the event that started it, its result, and its own facts. */
export interface RunInput {
	/** `GITHUB_EVENT_NAME`. Only `push` fires the alarm. */
	readonly event: string;
	readonly result: RunResult;
	/** The repo's declared alarm label, which a created issue carries alongside the triage label. */
	readonly label: string;
	readonly facts: RunFacts;
}

/**
 * The whole decision: which write this run owes, if any.
 *
 * A green run with no alarm open is the common case and it is a no-op — the recovery path must
 * never fail a run that had nothing to recover from.
 *
 * The event fence lives here as well as in each caller's `if:`, because the cost of a
 * `pull_request` run reaching this code is an alarm issue per pull request: a preview build's
 * redness is already on the pull request, and re-filing it as a main-is-broken report is a false
 * alarm nobody can tell from a true one.
 *
 * `cancelled` and `skipped` decide nothing either way. A cancelled run proves the branch neither
 * broken nor healthy, and closing a standing alarm off one is a false all-clear.
 */
export const decide = (input: RunInput, candidates: ReadonlyArray<IssueCandidate>): Decision => {
	if (input.event !== "push") {
		return {action: "noop", reason: `this is a \`${input.event}\` run, not a push — nothing fires`};
	}
	const alarm = selectAlarm(alarmMarker(input.facts.workflowKey), candidates);
	if (input.result === "failure") {
		if (alarm === null) {
			return {
				action: "create",
				title: alarmTitle(input.facts),
				body: alarmBody(input.facts),
				labels: [input.label, TRIAGE_LABEL],
				reason: "no alarm is open — this red opens one",
			};
		}
		return {
			action: "comment",
			issue: alarm.number,
			body: repeatCommentBody(input.facts),
			reason: `alarm #${alarm.number} is already open — this red comments on it`,
		};
	}
	if (input.result !== "success") {
		return {
			action: "noop",
			reason: `the run is \`${input.result}\`, which proves the branch neither red nor green`,
		};
	}
	if (alarm === null) {
		return {action: "noop", reason: "green, and no alarm is open — nothing to close"};
	}
	return {
		action: "close",
		issue: alarm.number,
		comment: recoveryCommentBody(input.facts),
		reason: `green — closing alarm #${alarm.number}`,
	};
};

/**
 * Lift the run's facts out of a GitHub Actions environment and the repo's declared mention list.
 *
 * Everything off the environment is a platform-supplied string, so a missing key reads as empty
 * rather than throwing: this path exists to deliver a notification, and a notifier that refuses to
 * speak because one label was blank has failed at the one thing it does. The mention list is the
 * opposite kind of input — it is declared config, already decoded or already refused.
 */
export const factsFromEnv = (
	env: Record<string, string | undefined>,
	mention: ReadonlyArray<string>,
	failedJobs: ReadonlyArray<string>,
	jobsRead: boolean,
): RunFacts => ({
	workflow: (env.GITHUB_WORKFLOW ?? "").trim() || "the workflow",
	workflowKey: workflowKeyFromEnv(env),
	runUrl:
		`${(env.GITHUB_SERVER_URL ?? "https://github.com").trim()}` +
		`/${(env.GITHUB_REPOSITORY ?? "").trim()}/actions/runs/${(env.GITHUB_RUN_ID ?? "").trim()}`,
	headSha: (env.GITHUB_SHA ?? "").trim(),
	branch: (env.GITHUB_REF_NAME ?? "").trim() || "the default branch",
	failedJobs,
	jobsRead,
	mention,
});
