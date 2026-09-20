/**
 * Deploy-tracker bin — the CI-callable IO shell over `./deploy-tracker.ts`'s pure {@link decide}:
 * read the run's facts off the environment, list the candidate trackers, perform the one write the
 * core named, and print what it did.
 *
 * **Not routed through `fabrika`'s bin, and that is the point.** This is a notification path that
 * fires precisely when the repository's own build just failed, so it must not depend on the install
 * that may be what broke. Its job runs checkout + setup-node + this file, with no `pnpm install`;
 * one relative plain-TS import is the whole module graph, and an `effect` import anywhere on it
 * would put the CLI's dependency tree between a red deploy and the ping about it. The same
 * constraint is why `required-bin.ts` is a bare bin.
 *
 * Every GitHub call is plain `fetch` against the REST API with the workflow's own `GITHUB_TOKEN` —
 * no client library, no new secret, nothing to install.
 *
 * Exits 0 when the decided write landed (or there was none to make) and 1 when it did not, so the
 * job goes red if the report itself failed to file. That redness is on the tracker job, never on
 * the deploy it is reporting: the deploy has already concluded by the time this runs.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9508
 */

import {
	decide,
	factsFromEnv,
	type IssueCandidate,
	type RunConclusion,
	TRACKER_LABEL,
} from "./deploy-tracker.ts";

const api = "https://api.github.com";
const repo = process.env.GITHUB_REPOSITORY ?? "";
const token = process.env.GITHUB_TOKEN ?? "";
const runId = process.env.GITHUB_RUN_ID ?? "";

const headers: Record<string, string> = {
	accept: "application/vnd.github+json",
	authorization: `Bearer ${token}`,
	"x-github-api-version": "2022-11-28",
	"content-type": "application/json",
};

const fail = (message: string): never => {
	console.log(`::error::deploy-tracker: ${message}`);
	process.exit(1);
};

const request = async (method: string, path: string, body?: unknown): Promise<Response> =>
	await fetch(`${api}${path}`, {
		method,
		headers,
		...(body === undefined ? {} : {body: JSON.stringify(body)}),
	});

/** A read the decision can live without: returns `null` rather than throwing, and says why. */
const readJson = async (path: string): Promise<unknown | null> => {
	try {
		const response = await request("GET", path);
		if (!response.ok) {
			console.log(`::warning::deploy-tracker: GET ${path} → ${response.status}`);
			return null;
		}
		return await response.json();
	} catch (error) {
		console.log(`::warning::deploy-tracker: GET ${path} failed — ${String(error)}`);
		return null;
	}
};

/** A write the decision cannot live without: a non-2xx is the job's redness. */
const mustWrite = async (method: string, path: string, body: unknown): Promise<void> => {
	const response = await request(method, path, body);
	if (!response.ok) {
		fail(`${method} ${path} → ${response.status} ${await response.text()}`);
	}
};

const failedJobNames = async (): Promise<{names: ReadonlyArray<string>; read: boolean}> => {
	const payload = await readJson(
		`/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
	);
	if (payload === null || typeof payload !== "object" || !("jobs" in payload)) {
		return {names: [], read: false};
	}
	const jobs = (payload as {jobs: unknown}).jobs;
	if (!Array.isArray(jobs)) return {names: [], read: false};
	const names = jobs
		.filter((job): job is {name: string; conclusion: string} => {
			const j = job as {name?: unknown; conclusion?: unknown};
			return typeof j.name === "string" && j.conclusion === "failure";
		})
		.map((job) => job.name);
	return {names, read: true};
};

/**
 * The open trackers, narrowed by label at the API and by author + marker in the core.
 *
 * An unreadable list is fatal rather than empty: reading "no tracker is open" off a failed request
 * is what opens a second issue for the same run of reds, which is the one outcome this exists to
 * prevent.
 */
const openCandidates = async (): Promise<ReadonlyArray<IssueCandidate>> => {
	const payload = await readJson(
		`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(TRACKER_LABEL)}&per_page=100`,
	);
	if (!Array.isArray(payload)) {
		return fail("the open-issue list could not be read, so whether a tracker is open is UNKNOWN");
	}
	return payload
		.filter((issue) => {
			const i = issue as {pull_request?: unknown};
			return i.pull_request === undefined;
		})
		.map((issue) => {
			const i = issue as {
				number: number;
				body?: string | null;
				user?: {login?: string; type?: string};
			};
			return {
				number: i.number,
				body: i.body ?? null,
				authorLogin: i.user?.login ?? null,
				authorType: i.user?.type ?? null,
			};
		});
};

/**
 * Create {@link TRACKER_LABEL} when the repository does not carry it yet.
 *
 * Adopting repositories have no such label, and an issue created with an unknown label is the one
 * failure mode that would silence the very first red. Idempotent: a 422 here is the label already
 * existing (a parallel run created it), which is the state we wanted.
 */
const ensureLabel = async (): Promise<void> => {
	const existing = await request(
		"GET",
		`/repos/${repo}/labels/${encodeURIComponent(TRACKER_LABEL)}`,
	);
	if (existing.ok) return;
	if (existing.status !== 404) {
		fail(`the label could not be read — GET labels → ${existing.status}`);
	}
	const created = await request("POST", `/repos/${repo}/labels`, {
		name: TRACKER_LABEL,
		color: "b60205",
		description: "Post-merge deploy tracker, opened and closed by the Deploy workflow itself",
	});
	if (!created.ok && created.status !== 422) {
		fail(`the label could not be created — POST labels → ${created.status}`);
	}
};

const conclusion: RunConclusion =
	process.env.TRACKER_CONCLUSION === "success" ? "success" : "failure";

if (repo === "" || token === "" || runId === "") {
	fail("GITHUB_REPOSITORY, GITHUB_TOKEN and GITHUB_RUN_ID must all be set");
}

const jobs = conclusion === "failure" ? await failedJobNames() : {names: [], read: true};
const facts = factsFromEnv(process.env, jobs.names, jobs.read);
if (facts.mention === "") {
	console.log("::warning::deploy-tracker: TRACKER_MENTION is empty — the report mentions nobody");
}

const decision = decide(conclusion, facts, await openCandidates());
console.log(`deploy-tracker: ${conclusion} — ${decision.reason}`);

switch (decision.action) {
	case "create":
		await ensureLabel();
		await mustWrite("POST", `/repos/${repo}/issues`, {
			title: decision.title,
			body: decision.body,
			labels: [...decision.labels],
		});
		break;
	case "comment":
		await mustWrite("POST", `/repos/${repo}/issues/${decision.issue}/comments`, {
			body: decision.body,
		});
		break;
	case "close":
		// Comment first: a close that lands without its explanation is a tracker that vanished.
		await mustWrite("POST", `/repos/${repo}/issues/${decision.issue}/comments`, {
			body: decision.comment,
		});
		await mustWrite("PATCH", `/repos/${repo}/issues/${decision.issue}`, {
			state: "closed",
			state_reason: "completed",
		});
		break;
	case "noop":
		break;
}
