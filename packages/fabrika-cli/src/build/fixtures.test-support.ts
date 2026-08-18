/**
 * The canned `gh` and `git` responses the `build` verb tests script their spawner with.
 *
 * They are shaped like the real payloads rather than like the parsers, so a parser that starts reading
 * a different field still has to find it here — a fixture trimmed to exactly what the code reads today
 * stops being able to catch tomorrow's misread.
 */
import {okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";

export const HEAD = "03135b9188d2be6c0a4b7bd0b7a3ff9c53f0f2b1";
export const OLD_HEAD = "8f1c2ad4e5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0";

/** What `git rev-parse` names for a checkout: its git dir, then its tree root. */
export const GIT_DIRS = okOut(["/repo/trees/lane-a/.git", "/repo/trees/lane-a"].join("\n"));

export const issue = (overrides: Record<string, unknown> = {}): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4312,
			title: "Editor loses focus after save",
			body: "## Acceptance criteria\n",
			state: "open",
			labels: [{name: "type:bug"}, {name: "p1"}, {name: "status:triaged"}],
			html_url: "https://github.com/o/r/issues/4312",
			milestone: null,
			state_reason: null,
			...overrides,
		}),
	);

export const pull = (overrides: Record<string, unknown> = {}): ExecResult =>
	okOut(
		JSON.stringify({
			number: 4318,
			state: "open",
			head: {sha: HEAD, ref: "build/4312-editor-focus-loss-c1a4d6f8"},
			body: "Fixes #4312\n\n## Deviations\nNone.\n",
			changed_files: 3,
			comments: 0,
			merged: false,
			...overrides,
		}),
	);

/** One paged `issues/<n>/comments` response. */
export const comments = (
	...rows: ReadonlyArray<{id: number; body: string; author?: string; createdAt?: string}>
): ExecResult =>
	okOut(
		JSON.stringify(
			rows.map((row) => ({
				id: row.id,
				body: row.body,
				user: {login: row.author ?? "agent"},
				created_at: row.createdAt ?? "2026-08-09T00:00:00Z",
			})),
		),
	);

/**
 * The same response, cut off before its last comment closes — what a killed `gh --paginate` leaves
 * on stdout, and the read a claim must never resolve ownership from.
 */
export const truncatedComments = (
	...rows: ReadonlyArray<{id: number; body: string; author?: string; createdAt?: string}>
): ExecResult => {
	const whole = comments(...rows).stdout;
	return okOut(whole.slice(0, whole.lastIndexOf("}")));
};

/** One paged `issues?labels=…` response, as the candidate pool reads it. */
export const candidates = (
	...rows: ReadonlyArray<{
		number: number;
		title?: string;
		labels: ReadonlyArray<string>;
		assignees?: ReadonlyArray<string>;
		milestone?: number | null;
		pull?: boolean;
	}>
): ExecResult =>
	okOut(
		JSON.stringify(
			rows.map((row) => ({
				number: row.number,
				title: row.title ?? `issue ${row.number}`,
				labels: row.labels.map((name) => ({name})),
				assignees: (row.assignees ?? []).map((login) => ({login})),
				milestone:
					row.milestone === undefined || row.milestone === null ? null : {number: row.milestone},
				...(row.pull === true ? {pull_request: {url: "…"}} : {}),
			})),
		),
	);

/** A `ROADMAP.md` whose `## Focus` table declares one milestone — the fence, switched on. */
export const focusTable = (milestone: number, declared = "2026-08-09"): string =>
	`# Roadmap\n\n## Focus\n\n| Milestone | Declared |\n|-----------|------------|\n| #${milestone} | ${declared} |\n\n## Arcs\n`;

/** The claim marker body a session posts. */
export const marker = (session: string, uuid: string): string =>
	`build-claim: build:${session}:${uuid} · 2026-08-09T00:00:00Z`;

export const LANE_UUID = "c1a4d6f8-3b7e-4a19-9c2d-5e8f0a1b2c3d";
/** The lane nonce `LANE_UUID` confers. */
export const NONCE = "c1a4d6f8";
/** The token the fixture lane holds — what it passes as `--token`. */
export const LANE_TOKEN = `build:s-9f2e:${LANE_UUID}`;

/** A second lane of the SAME session `s-9f2e` — the two-lanes-one-session shape (#6037). */
export const SIBLING_UUID = "7bab0955-616f-4a6a-af6e-71c34b7c68c7";
export const SIBLING_NONCE = "7bab0955";
export const SIBLING_TOKEN = `build:s-9f2e:${SIBLING_UUID}`;
