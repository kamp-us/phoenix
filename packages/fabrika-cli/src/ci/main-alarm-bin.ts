/**
 * Main-alarm bin — the CI-callable IO shell over `./main-alarm.ts`'s pure {@link decide}: read the
 * run's facts off the environment and its result off `--result`, resolve the repo's alarm settings,
 * list the candidate alarm issues, perform the one write the core named, and print what it did.
 *
 * **Not routed through `fabrika`'s bin, and that is the point.** This is the notification path for a
 * build that just broke, so it must not depend on the install that may be what broke. Its job runs
 * checkout + setup-node + this file, with no `pnpm install`; every import on the runtime graph is a
 * relative plain-TS module the runtime type-strips, and an `effect` import anywhere on it would put
 * the CLI's dependency tree between a red main and the ping about it. The config half is read
 * through `config/document.ts` over `io/json.ts` for exactly that reason — the Effect file opener
 * would put `effect` back on this graph. The same constraint is why `required-bin.ts` is a bare bin.
 *
 * Every GitHub call is plain `fetch` against the REST API with the workflow's own `GITHUB_TOKEN` —
 * no client library, no new secret, nothing to install.
 *
 * Exits 0 when the decided write landed (or there was none to make) and 1 when it did not, so the
 * job goes red if the report itself failed to file. That redness is on the alarm job, never on the
 * work it reports: that work has already concluded by the time this runs.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9508
 */

import {readFileSync} from "node:fs";
import {CONFIG_PATH, type ConfigSource, readDocument} from "../config/document.ts";
import {resolveKey} from "../config/key-group.ts";
import {ciKey} from "../config/keys/ci.ts";
import {
	decide,
	decodeResult,
	factsFromEnv,
	type IssueCandidate,
	type RunResult,
} from "./main-alarm.ts";

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
	console.log(`::error::main-alarm: ${message}`);
	process.exit(1);
};

const request = async (method: string, path: string, body?: unknown): Promise<Response> =>
	await fetch(`${api}${path}`, {
		method,
		headers,
		...(body === undefined ? {} : {body: JSON.stringify(body)}),
	});

/** A read the decision can live without: returns `null` rather than throwing, and says why. */
const readJson = async (path: string): Promise<unknown> => {
	try {
		const response = await request("GET", path);
		if (!response.ok) {
			console.log(`::warning::main-alarm: GET ${path} → ${response.status}`);
			return null;
		}
		return await response.json();
	} catch (error) {
		console.log(`::warning::main-alarm: GET ${path} failed — ${String(error)}`);
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

/**
 * `--result <value>` — the run result the alarm judges, from the caller's `needs.*.result`.
 *
 * Refused rather than defaulted on anything Actions never emits: a misspelled value read as
 * `failure` opens alarms on green pushes, and read as `success` closes a live one.
 */
const resultFromArgv = (argv: ReadonlyArray<string>): RunResult => {
	const at = argv.indexOf("--result");
	const raw = at === -1 ? "" : (argv[at + 1] ?? "");
	if (raw === "") return fail("--result <success|failure|cancelled|skipped> is required");
	const decoded = decodeResult(raw);
	return decoded ?? fail(`--result ${raw} is not a result Actions emits`);
};

/**
 * The repo's alarm settings, off `.fabrika.jsonc` at the checkout this job made.
 *
 * `Malformed` and `Unknown` both refuse. The label is the dedup identity, so running on the shipped
 * default where the repo declared something else would look for an alarm under a name nothing files
 * under, and open a fresh issue on every red — the one outcome this whole path exists to prevent.
 */
const alarmSettings = (): {mention: ReadonlyArray<string>; label: string} => {
	let source: ConfigSource;
	try {
		source = {_tag: "Text", text: readFileSync(CONFIG_PATH, "utf8")};
	} catch (error) {
		source =
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? {_tag: "Absent"}
				: {_tag: "Unreadable", reason: `${CONFIG_PATH} could not be read — ${String(error)}`};
	}
	const resolved = resolveKey(readDocument(source), ciKey);
	if (resolved._tag === "Malformed" || resolved._tag === "Unknown") {
		return fail(`the alarm settings are unusable — ${resolved.reason}`);
	}
	return resolved.value.mainAlarm;
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
 * The open alarm candidates, narrowed by label at the API and by author + marker in the core.
 *
 * An unreadable list is fatal rather than empty: reading "no alarm is open" off a failed request is
 * what opens a second issue for the same run of reds, which is the one outcome this exists to
 * prevent.
 */
const openCandidates = async (label: string): Promise<ReadonlyArray<IssueCandidate>> => {
	const payload = await readJson(
		`/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
	);
	if (!Array.isArray(payload)) {
		return fail("the open-issue list could not be read, so whether an alarm is open is UNKNOWN");
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
 * Create the alarm label when the repository does not carry it yet.
 *
 * An adopting repository has no such label, and an issue created with an unknown label is the one
 * failure mode that would silence the very first red. Idempotent: a 422 here is the label already
 * existing (a parallel run created it), which is the state we wanted.
 */
const ensureLabel = async (label: string): Promise<void> => {
	const existing = await request("GET", `/repos/${repo}/labels/${encodeURIComponent(label)}`);
	if (existing.ok) return;
	if (existing.status !== 404) {
		fail(`the label could not be read — GET labels → ${existing.status}`);
	}
	const created = await request("POST", `/repos/${repo}/labels`, {
		name: label,
		color: "b60205",
		description: "A push to the default branch went red; opened and closed by the workflow itself",
	});
	if (!created.ok && created.status !== 422) {
		fail(`the label could not be created — POST labels → ${created.status}`);
	}
};

const result = resultFromArgv(process.argv.slice(2));

if (repo === "" || token === "" || runId === "") {
	fail("GITHUB_REPOSITORY, GITHUB_TOKEN and GITHUB_RUN_ID must all be set");
}

const settings = alarmSettings();
const jobs = result === "failure" ? await failedJobNames() : {names: [], read: true};
const facts = factsFromEnv(process.env, settings.mention, jobs.names, jobs.read);
// Only the red path carries a mention; a recovery comment wakes nobody by design, so warning there
// would put a warning annotation on every green push.
if (result === "failure" && facts.mention.length === 0) {
	console.log("::warning::main-alarm: ci.mainAlarm.mention is empty — the report mentions nobody");
}

const decision = decide(
	{event: process.env.GITHUB_EVENT_NAME ?? "", result, label: settings.label, facts},
	await openCandidates(settings.label),
);
console.log(`main-alarm: ${result} — ${decision.reason}`);

switch (decision.action) {
	case "create":
		await ensureLabel(settings.label);
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
		// Comment first: a close that lands without its explanation is an alarm that vanished.
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
