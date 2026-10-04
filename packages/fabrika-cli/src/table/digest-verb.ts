/**
 * `table digest` — post the issues past their response target to the chat webhook the repository's
 * `digest` block names.
 *
 * With no `digest` block it reads nothing and sends nothing. The triage section reads the open
 * issues alone. The on-call section also reads the on-call board, the read `table flags` makes, so
 * it needs a token that can read the project.
 *
 * **A source it could not read is a refusal, never an empty report**, and so is a post that did not
 * land: a scheduled run that goes quiet has to mean nothing is late.
 *
 * **The webhook URL reaches the post and nothing else.** It is read from the environment variable
 * the block names, and every line this verb prints about a failed post has the URL struck from it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10357
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {boardsKey} from "../config/keys/boards.ts";
import {type ChatTool, type DigestSettings, digestKey} from "../config/keys/digest.ts";
import {readKey} from "../config/read-key.ts";
import type {Attempt} from "../io/git.ts";
import {type ListedIssue, listOpenIssueFacts, resolveRepo} from "../io/issues.ts";
import {withProjects} from "../io/projects.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {CONFIG_MALFORMED, NO_WEBHOOK, PRECONDITION_UNKNOWN, WRITE_UNKNOWN} from "./codes.ts";
import {digestOf, lateCount, type OnCallQueue, renderDigest} from "./digest.ts";
import {postWebhook} from "./digest-post.ts";
import {onCallItemsOf, readOnCall} from "./on-call-prep.ts";
import {locateTable, syncBoard, type TableBoard} from "./sync-verb.ts";

const VERB = "table digest";

/** Every read the verb makes and its one write, passed in so it stays provable offline. */
export interface DigestBoard<R> extends Pick<TableBoard<R>, "locate" | "items"> {
	readonly openIssues: (
		repo: string,
	) => Effect.Effect<Attempt<ReadonlyArray<ListedIssue>>, never, R>;
	readonly post: (tool: ChatTool, url: URL, text: string) => Effect.Effect<Attempt<null>, never, R>;
}

export interface DigestOptions<R> {
	readonly repo: string | null;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly now: Date;
	readonly board: DigestBoard<R>;
	readonly dryRun: boolean;
}

type Webhook =
	| {readonly _tag: "Url"; readonly url: URL; readonly raw: string}
	| {readonly _tag: "None"; readonly reason: string};

/** The webhook URL off the variable the block names, or what is wrong with it, never its value. */
const webhookOf = (
	settings: DigestSettings,
	env: Readonly<Record<string, string | undefined>>,
): Webhook => {
	const raw = (env[settings.webhookEnv] ?? "").trim();
	const variable = `the environment variable ${settings.webhookEnv}, named by \`digest.webhookEnv\`,`;
	if (raw === "") return {_tag: "None", reason: `${variable} is unset or empty`};
	if (!URL.canParse(raw)) return {_tag: "None", reason: `${variable} does not hold a URL`};
	const url = new URL(raw);
	return url.protocol === "https:" || url.protocol === "http:"
		? {_tag: "Url", url, raw}
		: {_tag: "None", reason: `${variable} does not hold an http(s) URL`};
};

const ON_CALL_FIX =
	"The on-call section reads the on-call board, so the run needs a token that can read the project; leave `on-call` out of `digest.sections` to report the triage queue alone. Nothing was sent, and this is not an empty report.";

export const runDigest = <R>(
	options: DigestOptions<R>,
): Effect.Effect<
	VerbOutcome,
	never,
	R | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const digest = yield* readKey(options.cwd, digestKey);
		if (digest._tag === "Refused") {
			return refuse(CONFIG_MALFORMED, `${VERB}: ${digest.reason}. Nothing was read from GitHub.`);
		}
		if (digest.value._tag === "Off") {
			return answer(`${JSON.stringify({answer: "off"})}\n`, [
				`${VERB}: read ${digest.note}; the report is off. Nothing was read from GitHub and nothing was sent.`,
			]);
		}
		const settings = digest.value;
		const boards = yield* readKey(options.cwd, boardsKey);
		if (boards._tag === "Refused") {
			return refuse(CONFIG_MALFORMED, `${VERB}: ${boards.reason}. Nothing was read from GitHub.`);
		}
		const webhook = options.dryRun ? null : webhookOf(settings, options.env);
		if (webhook?._tag === "None") {
			return refuse(
				NO_WEBHOOK,
				`${VERB}: ${webhook.reason}. Nothing was read from GitHub and nothing was sent.`,
			);
		}
		const resolved = yield* resolveRepo(options.repo, options.env);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: no --repo, no CLAUDE_PIPELINE_REPO, no GITHUB_REPOSITORY and no readable origin remote — no repository to report on. Nothing was sent.`,
			);
		}
		const repo = resolved.value;
		const {board} = options;
		const listing = yield* board.openIssues(repo);
		if (listing._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${repo}'s open issues: ${listing.reason}. Nothing was sent, and this is not an empty report.`,
			);
		}
		let onCall: OnCallQueue | null = null;
		if (settings.sections.includes("on-call")) {
			const read = yield* readOnCall(board, VERB, repo, boards.value);
			if (read._tag === "Refused") return refuse(read.code, `${read.reason} ${ON_CALL_FIX}`);
			if (read._tag === "Split") {
				const open = new Map(listing.value.map((issue) => [issue.number, issue] as const));
				onCall = {
					targets: read.settings.responseTargets,
					boardCreatedAt: read.project.createdAt,
					open: onCallItemsOf(read.rows, open, []),
				};
			}
		}
		const report = digestOf({now: options.now, open: listing.value, settings, onCall});
		const late = lateCount(report);
		const notes = [
			`${VERB}: read ${digest.note}; ${boards.note}.`,
			`${VERB}: ${listing.value.length} open issue(s) in ${repo}; ${late} past a response target.`,
			...report.notAsked.map(
				(section) =>
					`${VERB}: the ${section} section was not asked: .fabrika.jsonc declares no \`boards.onCall\`, so no issue has a response target.`,
			),
		];
		const facts = {
			repo,
			tool: settings.tool,
			late,
			sections: report.sections.map((section) => ({
				section: section.section,
				late: section.late.map(({title: _title, ...fields}) => fields),
			})),
			notAsked: report.notAsked,
		};
		if (late === 0 && !settings.allClear) {
			return answer(`${JSON.stringify({answer: "quiet", ...facts, text: null})}\n`, [
				...notes,
				`${VERB}: nothing to report and \`digest.allClear\` is off, so nothing was sent.`,
			]);
		}
		const text = renderDigest(report, {
			repo,
			serverUrl: (options.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, ""),
			tool: settings.tool,
		});
		if (webhook === null) {
			return answer(`${JSON.stringify({answer: "dry-run", ...facts, text})}\n`, [
				...notes,
				`${VERB}: --dry-run, so nothing was sent.`,
			]);
		}
		const posted = yield* board.post(settings.tool, webhook.url, text);
		if (posted._tag === "Failure") {
			const reason = posted.reason
				.replaceAll(webhook.raw, "<webhook URL>")
				.replaceAll(webhook.url.href, "<webhook URL>");
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the post to the ${settings.tool} webhook did not land: ${reason}. The report was built and not delivered.`,
			);
		}
		return answer(`${JSON.stringify({answer: "sent", ...facts, text})}\n`, [
			...notes,
			`${VERB}: posted to the ${settings.tool} webhook.`,
		]);
	});

/** The shipped board: GitHub under the ambient token, and the webhook over HTTP. */
export const digestBoard: DigestBoard<ChildProcessSpawner.ChildProcessSpawner> = {
	locate: (repo, target) => withProjects((token) => locateTable(token, repo, target, VERB)),
	items: syncBoard.items,
	openIssues: listOpenIssueFacts,
	post: postWebhook,
};
