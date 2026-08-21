/**
 * The scripted board both `decision` verb tests drive against.
 *
 * One issue (#4300), one control-plane roster, one cited ruling comment. Each helper takes what the
 * case under test varies and holds everything else fixed, so a test reads as the one fact it pins.
 */

import type {HttpReply} from "../fakes.test-support.ts";

export const REPO = "o/r";
export const ISSUE = 4300;
export const RULER = "usirin";
export const RULING_COMMENT = 900001;
export const RULING_URL = `https://github.com/${REPO}/issues/${ISSUE}#issuecomment-${RULING_COMMENT}`;
export const MARKER_COMMENT = 900002;
export const BODY = "## The decision\n\nWhich fork?\n";

export const env = {CLAUDE_PIPELINE_REPO: REPO, GITHUB_TOKEN: "ghp_scripted"} as Record<
	string,
	string | undefined
>;
export const NOW = () => new Date("2026-08-20T05:11:02.500Z");

/** The reads this group makes over the fetch client, matched on `METHOD url` (ADR 0315). */
const API = "https:\\/\\/api\\.github\\.com";
export const ISSUE_READ = new RegExp(`^GET ${API}\\/repos\\/${REPO}\\/issues\\/${ISSUE}$`);
export const COMMENTS = new RegExp(
	`^GET ${API}\\/repos\\/${REPO}\\/issues\\/${ISSUE}\\/comments\\?`,
);
export const VIEWER = new RegExp(`^GET ${API}\\/user$`);
export const TRUNK = new RegExp(`^GET ${API}\\/repos\\/${REPO}$`);
export const CODEOWNERS = /contents\/\.github\/CODEOWNERS\?ref=main$/;
export const MEMBERS = new RegExp(`^GET ${API}\\/orgs\\/kamp-us\\/teams\\/control-plane\\/members`);
export const LABELS = new RegExp(`^GET ${API}\\/repos\\/${REPO}\\/labels\\?`);
export const POST = new RegExp(`^POST ${API}\\/repos\\/${REPO}\\/issues\\/${ISSUE}\\/comments$`);
export const GET_MARKER = new RegExp(
	`^GET ${API}\\/repos\\/${REPO}\\/issues\\/comments\\/${MARKER_COMMENT}$`,
);
export const ADD_LABEL = new RegExp(`^POST ${API}\\/repos\\/${REPO}\\/issues\\/${ISSUE}\\/labels$`);
export const REMOVE_LABEL = new RegExp(
	`^DELETE ${API}\\/repos\\/${REPO}\\/issues\\/${ISSUE}\\/labels\\/`,
);

const served = (body: unknown): HttpReply => ({status: 200, body: JSON.stringify(body)});

/** The issue as `GET /repos/o/r/issues/4300` answers, with whatever labels the case wants. */
export const issueRead = (
	labels: ReadonlyArray<string> = ["type:decision", "ready-for:human"],
	body: string = BODY,
): HttpReply =>
	served({
		number: ISSUE,
		title: "Which fork?",
		body,
		state: "open",
		labels: labels.map((name) => ({name})),
		html_url: `https://github.com/${REPO}/issues/${ISSUE}`,
		user: {login: "agent"},
	});

/** One page of comments, each `[id, author, body]`. */
export const comments = (...rows: ReadonlyArray<readonly [number, string, string]>): HttpReply =>
	served(
		rows.map(([id, author, body]) => ({
			id,
			user: {login: author},
			created_at: "2026-08-20T05:00:00Z",
			updated_at: "2026-08-20T05:00:00Z",
			body,
		})),
	);

/** The cited ruling comment on its own — the fixture every authorized case starts from. */
export const RULING_ONLY = comments([RULING_COMMENT, RULER, "Take the second fork. Ruled."]);

/** The roster reads, all four of them, resolving to a two-account control plane. */
export const acl: ReadonlyArray<readonly [RegExp, HttpReply]> = [
	[VIEWER, served({login: RULER})],
	[TRUNK, served({default_branch: "main"})],
	[CODEOWNERS, {status: 200, body: "/packages/fabrika-cli/ @kamp-us/control-plane\n"}],
	[MEMBERS, served([{login: RULER}, {login: "cansirin"}])],
];

export const taxonomy = served(
	["type:decision", "ready-for:agent", "ready-for:human", "status:triaged"].map((name) => ({name})),
);

export const POSTED: HttpReply = {
	status: 201,
	body: JSON.stringify({
		id: MARKER_COMMENT,
		html_url: `https://github.com/${REPO}/issues/${ISSUE}#c`,
	}),
};

/** A label write's answer — the endpoint echoes the issue's label set, which nothing reads. */
export const LABEL_WRITTEN: HttpReply = {status: 200, body: "[]"};
