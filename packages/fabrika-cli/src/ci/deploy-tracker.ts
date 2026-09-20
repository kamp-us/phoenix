/**
 * Deploy-tracker core — the pure, IO-free decision behind a post-merge deploy workflow's own
 * failure hook: on a red push-to-main run, open one tracking issue or comment on the one already
 * open; on the next green run, close it.
 *
 * A workflow that only runs after merge reports to nobody. Its red is a check mark on a commit, and
 * a commit nobody is looking at carries it silently for as long as it takes someone to ask why the
 * branch is red. The hook is the workflow reporting its own failure, and the thing that makes it
 * bearable is that a run of reds produces ONE issue and a comment each, never one issue per run.
 *
 * **Dedup is on a body marker plus the label, never on title text.** A title is prose someone edits;
 * {@link TRACKER_MARKER} is an HTML comment nothing renders and nothing rewrites, and
 * {@link TRACKER_LABEL} narrows the lookup to a handful of issues before the marker decides. The
 * lookup is author-constrained on top: only the CI bot's own issue is a tracker, so a human issue
 * quoting the marker can never be commented on or closed by this path.
 *
 * **No `effect` import, here or in `deploy-tracker-bin.ts`.** This pair is a bare bin rather than a
 * registered `fabrika ci …` verb for the reason `required.ts` is: the job that runs it is a
 * notification path, so it must not depend on the install that may be exactly what broke. Checkout
 * + setup-node + node, no `pnpm install`, nothing linked — the whole module graph is one relative
 * plain-TS import the runtime type-strips.
 *
 * No IO: `deploy-tracker-bin.ts` reads the run's facts and the candidate issues and performs the
 * write; this decides which write it is and what it says.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9508
 */

/** The HTML-comment key that makes an issue this workflow's tracker. Never rendered, never edited. */
export const TRACKER_MARKER = "<!-- deploy-failure-tracker -->";

/** The label the tracker is opened with, so the lookup is a filtered list rather than a full scan. */
export const TRACKER_LABEL = "deploy-failure-tracker";

/** Intake's own entry label — the tracker lands as an ordinary report and is triaged like one. */
export const TRIAGE_LABEL = "status:needs-triage";

/**
 * The author a tracker must carry. The default token posts as this bot, so anything else carrying
 * the marker is a human's issue that merely quotes it.
 */
export const TRACKER_AUTHOR = "github-actions[bot]";

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
	 * The login to `@`-mention, so GitHub's own notifications deliver the ping. Empty omits the
	 * mention line: who to wake is the calling repository's fact, not this module's.
	 */
	readonly mention: string;
}

/** The workflow run's own conclusion, which picks the branch of {@link decide}. */
export type RunConclusion = "failure" | "success";

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

const isTracker = (candidate: IssueCandidate): boolean =>
	candidate.authorLogin === TRACKER_AUTHOR &&
	candidate.authorType === "Bot" &&
	(candidate.body ?? "").includes(TRACKER_MARKER);

/**
 * The one tracker among the open candidates, or `null`.
 *
 * Lowest number wins so a board that somehow carries two is decided the same way on every run: the
 * older issue is the one with the history on it, and the younger is the duplicate a human closes.
 */
export const selectTracker = (candidates: ReadonlyArray<IssueCandidate>): IssueCandidate | null => {
	let found: IssueCandidate | null = null;
	for (const candidate of candidates) {
		if (!isTracker(candidate)) continue;
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

const mentionLine = (facts: RunFacts): string =>
	facts.mention === "" ? "" : `\n\n@${facts.mention}`;

/** The tracker's title. Stable on purpose: nothing keys on it, and a run number in it would churn. */
export const trackerTitle = (facts: RunFacts): string =>
	`\`${facts.workflow}\` is failing on pushes to \`${facts.branch}\``;

export const trackerBody = (facts: RunFacts): string =>
	`${TRACKER_MARKER}
The \`${facts.workflow}\` workflow failed on a push to \`${facts.branch}\`. That run happens only after
merge, so no pull-request gate can catch it and nothing else reports it — this issue is the report.${mentionLine(facts)}

${runFactLines(facts)}

Every later red push-to-\`${facts.branch}\` run of this workflow comments here instead of opening a
second issue. The next green run closes this issue with a link to that run.
`;

export const repeatCommentBody = (facts: RunFacts): string =>
	`${TRACKER_MARKER}
Still red — \`${facts.workflow}\` failed again on a push to \`${facts.branch}\`.${mentionLine(facts)}

${runFactLines(facts)}
`;

export const recoveryCommentBody = (facts: RunFacts): string =>
	`${TRACKER_MARKER}
Green again — \`${facts.workflow}\` succeeded on a push to \`${facts.branch}\`, so this tracker is closed.

- **Run:** ${facts.runUrl}
- **Head commit:** \`${shortSha(facts.headSha)}\` (\`${facts.headSha}\`)

A later red push-to-\`${facts.branch}\` run opens a fresh tracker.
`;

/**
 * The whole decision: which write this run owes, if any.
 *
 * A green run with no tracker open is the common case and it is a no-op — the recovery path must
 * never fail a run that had nothing to recover from.
 */
export const decide = (
	conclusion: RunConclusion,
	facts: RunFacts,
	candidates: ReadonlyArray<IssueCandidate>,
): Decision => {
	const tracker = selectTracker(candidates);
	if (conclusion === "failure") {
		if (tracker === null) {
			return {
				action: "create",
				title: trackerTitle(facts),
				body: trackerBody(facts),
				labels: [TRACKER_LABEL, TRIAGE_LABEL],
				reason: "no tracker is open — this red opens one",
			};
		}
		return {
			action: "comment",
			issue: tracker.number,
			body: repeatCommentBody(facts),
			reason: `tracker #${tracker.number} is already open — this red comments on it`,
		};
	}
	if (tracker === null) {
		return {action: "noop", reason: "green, and no tracker is open — nothing to close"};
	}
	return {
		action: "close",
		issue: tracker.number,
		comment: recoveryCommentBody(facts),
		reason: `green — closing tracker #${tracker.number}`,
	};
};

/**
 * Lift the run's facts out of a GitHub Actions environment.
 *
 * Everything here is a workflow-supplied string, so a missing key reads as empty rather than
 * throwing: this path exists to deliver a notification, and a notifier that refuses to speak
 * because one label was blank has failed at the one thing it does.
 */
export const factsFromEnv = (
	env: Record<string, string | undefined>,
	failedJobs: ReadonlyArray<string>,
	jobsRead: boolean,
): RunFacts => ({
	workflow: (env.TRACKER_WORKFLOW ?? "").trim() || "the workflow",
	runUrl: (env.TRACKER_RUN_URL ?? "").trim(),
	headSha: (env.TRACKER_HEAD_SHA ?? "").trim(),
	branch: (env.TRACKER_BRANCH ?? "").trim() || "main",
	failedJobs,
	jobsRead,
	mention: (env.TRACKER_MENTION ?? "").trim().replace(/^@/, ""),
});
