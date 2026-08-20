/**
 * The scripted board both `decision` verb tests drive against.
 *
 * One issue (#4300), one control-plane roster, one cited ruling comment. Each helper takes what the
 * case under test varies and holds everything else fixed, so a test reads as the one fact it pins.
 */

import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";

export const REPO = "o/r";
export const ISSUE = 4300;
export const RULER = "usirin";
export const RULING_COMMENT = 900001;
export const RULING_URL = `https://github.com/${REPO}/issues/${ISSUE}#issuecomment-${RULING_COMMENT}`;
export const MARKER_COMMENT = 900002;
export const BODY = "## The decision\n\nWhich fork?\n";

export const env = {CLAUDE_PIPELINE_REPO: REPO} as Record<string, string | undefined>;
export const NOW = () => new Date("2026-08-20T05:11:02.500Z");

export const ISSUE_READ = new RegExp(`^gh api repos/${REPO}/issues/${ISSUE}$`);
export const COMMENTS = new RegExp(`^gh api --paginate repos/${REPO}/issues/${ISSUE}/comments`);
export const VIEWER = /^gh api user --jq \.login$/;
export const TRUNK = new RegExp(`^gh api repos/${REPO} --jq \\.default_branch$`);
export const CODEOWNERS = /contents\/\.github\/CODEOWNERS\?ref=main$/;
export const MEMBERS = /^gh api --paginate orgs\/kamp-us\/teams\/control-plane\/members/;
export const LABELS = new RegExp(`^gh api --paginate repos/${REPO}/labels`);
export const POST = new RegExp(`^gh api --method POST repos/${REPO}/issues/${ISSUE}/comments -f `);
export const GET_MARKER = new RegExp(`^gh api repos/${REPO}/issues/comments/${MARKER_COMMENT}$`);
export const ADD_LABEL = new RegExp(`^gh api --method POST repos/${REPO}/issues/${ISSUE}/labels`);
export const REMOVE_LABEL = new RegExp(
	`^gh api --method DELETE repos/${REPO}/issues/${ISSUE}/labels/`,
);

/** The issue as `gh api repos/o/r/issues/4300` answers, with whatever labels the case wants. */
export const issueRead = (
	labels: ReadonlyArray<string> = ["type:decision", "ready-for:human"],
	body: string = BODY,
): ExecResult =>
	okOut(
		JSON.stringify({
			number: ISSUE,
			title: "Which fork?",
			body,
			state: "open",
			labels: labels.map((name) => ({name})),
			html_url: `https://github.com/${REPO}/issues/${ISSUE}`,
			user: {login: "agent"},
		}),
	);

/** One page of comments, each `[id, author, body]`. */
export const comments = (...rows: ReadonlyArray<readonly [number, string, string]>): ExecResult =>
	okOut(
		JSON.stringify(
			rows.map(([id, author, body]) => ({
				id,
				user: {login: author},
				created_at: "2026-08-20T05:00:00Z",
				updated_at: "2026-08-20T05:00:00Z",
				body,
			})),
		),
	);

/** The cited ruling comment on its own — the fixture every authorized case starts from. */
export const RULING_ONLY = comments([RULING_COMMENT, RULER, "Take the second fork. Ruled."]);

/** The roster reads, all four of them, resolving to a two-account control plane. */
export const acl: ReadonlyArray<readonly [RegExp, ExecResult]> = [
	[VIEWER, okOut(`${RULER}\n`)],
	[TRUNK, okOut("main\n")],
	[CODEOWNERS, okOut("/packages/fabrika-cli/ @kamp-us/control-plane\n")],
	[MEMBERS, okOut(JSON.stringify([{login: RULER}, {login: "cansirin"}]))],
];

export const taxonomy = okOut("type:decision\nready-for:agent\nready-for:human\nstatus:triaged");

export const POSTED = okOut(
	JSON.stringify({id: MARKER_COMMENT, html_url: `https://github.com/${REPO}/issues/${ISSUE}#c`}),
);
