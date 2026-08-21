/**
 * The one repo all three `campaign` verb tests drive against: a two-row `ROADMAP.md`, a
 * `.fabrika.jsonc` naming one author, and one cited comment carrying the marker.
 *
 * Each helper takes what the case under test varies and holds everything else fixed, so a test reads
 * as the one fact it pins.
 */

import {Layer} from "effect";
import {
	type FakeFsOptions,
	fakeFs,
	fakeSeams,
	type HttpReply,
	type Scripted,
} from "../fakes.test-support.ts";

export const REPO = "o/r";
export const AUTHOR = "usirin";
export const COMMENT = 900001;
export const CITES = `https://github.com/${REPO}/issues/6289#issuecomment-${COMMENT}`;
export const ROOT = "/repo";
export const FILE = "ROADMAP.md";
export const ROADMAP_PATH = `${ROOT}/${FILE}`;
export const CONFIG_FILE = `${ROOT}/.fabrika.jsonc`;

export const env = {CLAUDE_PIPELINE_REPO: REPO, GITHUB_TOKEN: "ghp_scripted"} as Record<
	string,
	string | undefined
>;

/** The two-row table every example in the contract runs against. */
export const TWO_ROWS = `# Roadmap

## Campaigns

| Campaign | Milestone | State |
|----------|-----------|-------|
| Taste-Skill Library | #42 | paused |
| fabrika everywhere | #47 | active |

## Dependency graph

nothing here.
`;

export const config = (...authors: ReadonlyArray<string>): string =>
	JSON.stringify({campaignAuthors: authors}, null, 2);

const API = "https:\\/\\/api\\.github\\.com";
export const GET_COMMENT = new RegExp(
	`^GET ${API}\\/repos\\/${REPO}\\/issues\\/comments\\/${COMMENT}$`,
);
export const PERMISSION = new RegExp(
	`^GET ${API}\\/repos\\/${REPO}\\/collaborators\\/${AUTHOR}\\/permission$`,
);
export const MEMBERSHIP = new RegExp(
	`^GET ${API}\\/orgs\\/kamp-us\\/teams\\/founders\\/memberships\\/${AUTHOR}$`,
);
export const TEAM = new RegExp(`^GET ${API}\\/orgs\\/kamp-us\\/teams\\/founders$`);

const served = (body: unknown): HttpReply => ({status: 200, body: JSON.stringify(body)});

/** The cited comment, with whatever first line the case wants. */
export const comment = (body: string, author: string = AUTHOR): HttpReply =>
	served({
		id: COMMENT,
		user: {login: author},
		created_at: "2026-08-20T04:11:09Z",
		updated_at: "2026-08-20T04:11:09Z",
		body,
	});

export const marker = (milestone: number, state: string): string =>
	`campaign-approve: #${milestone} ${state} · 2026-08-20T04:11:09Z`;

export const permission = (level: string): HttpReply => served({permission: level});

/** The scripted board an authorized write runs against. */
export const approving = (milestone: number, state: string): ReadonlyArray<Scripted> => [
	[GET_COMMENT, comment(marker(milestone, state))],
	[PERMISSION, permission("write")],
];

export interface Seams {
	readonly layer: Layer.Layer<never>;
	readonly written: Map<string, string>;
	readonly requests: ReadonlyArray<string>;
}

/** Both IO seams over one scripted board and one in-memory tree. */
export const seams = (script: ReadonlyArray<Scripted>, fs: FakeFsOptions) => {
	const tree = fakeFs(fs);
	const board = fakeSeams(script);
	return {
		layer: Layer.merge(tree.layer, board.layer),
		written: tree.written,
		requests: board.requests,
	};
};

/** The default tree: the two-row roadmap and a config naming `@usirin`. */
export const tree = (
	roadmap: string = TWO_ROWS,
	fabrika: string = config(`@${AUTHOR}`),
): FakeFsOptions => ({files: {[ROADMAP_PATH]: roadmap, [CONFIG_FILE]: fabrika}});
