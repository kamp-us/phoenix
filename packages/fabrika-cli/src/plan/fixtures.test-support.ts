/**
 * The canned GitHub responses the `plan` verb tests script their seams with.
 *
 * Shaped like the real payloads rather than like the parsers, so a parser that starts reading a
 * different field still has to find it here — a fixture trimmed to exactly what the code reads today
 * stops being able to catch tomorrow's misread. The child payload carries its `assignees` key by
 * default and {@link child} can drop it entirely, because *the key was not there* is the fact
 * `UNVERIFIABLE_ASSIGNEE` rests on and no fixture that always includes it could exercise the split.
 */

import type {FileSystem, Path} from "effect";
import {Effect, Layer} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {CONFIG_PATH} from "../config/document.ts";
import type {FakeHttp, FakeShell, HttpReply} from "../fakes.test-support.ts";
import {fakeFs, fakeHttp, fakeShell} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {runRead} from "./read-verb.ts";

export const EPIC = 4300;
export const SESSION = "s-9f2e";

/** An epic body with one phase line, two contiguous stories, and no fenced decoys. */
export const epicBody = (overrides: {dependencies?: string; stories?: string} = {}): string =>
	[
		"An epic.",
		"",
		"### User stories",
		"",
		overrides.stories ??
			"1. As a planner, I want a gate.\n2. As a builder, I want pickable children.",
		"",
		"## Dependencies",
		"",
		overrides.dependencies ?? "- phase 1: #4301, #4302",
		"",
	].join("\n");

export const epic = (overrides: Record<string, unknown> = {}): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: EPIC,
		title: "The plan gate",
		body: epicBody(),
		state: "open",
		labels: [{name: "type:epic"}],
		html_url: "https://github.com/o/r/issues/4300",
		milestone: null,
		state_reason: null,
		...overrides,
	}),
});

export const subIssues = (...numbers: ReadonlyArray<number>): HttpReply => ({
	status: 200,
	body: JSON.stringify(
		numbers.map((number) => ({
			number,
			title: `child ${number}`,
			state: "open",
			state_reason: null,
		})),
	),
});

/** A child body that clears the floor: criteria, a story claim, and a containment marker. */
export const childBody = (
	overrides: {stories?: string | null; containment?: string | null; criteria?: string} = {},
): string =>
	[
		"### Acceptance criteria",
		"",
		overrides.criteria ?? "- [ ] the verb runs\n- [ ] the guard reds",
		"",
		overrides.stories === null ? "" : `**Stories:** ${overrides.stories ?? "1, 2"}`,
		overrides.containment === null ? "" : `**Containment:** ${overrides.containment ?? "flag"}`,
		"",
	].join("\n");

export const child = (options: {
	number: number;
	labels?: ReadonlyArray<string>;
	assignees?: ReadonlyArray<string> | null;
	body?: string;
	state?: string;
}): HttpReply => ({
	status: 200,
	body: JSON.stringify({
		number: options.number,
		title: `child ${options.number}`,
		body: options.body ?? childBody(),
		state: options.state ?? "open",
		labels: (options.labels ?? ["type:feature", "p1", "status:planned"]).map((name) => ({name})),
		// `null` drops the key entirely — the unobserved slot, not an observed-empty one.
		...(options.assignees === null
			? {}
			: {assignees: (options.assignees ?? []).map((login) => ({login}))}),
		html_url: `https://github.com/o/r/issues/${options.number}`,
	}),
});

export const labelSet = (...names: ReadonlyArray<string>): HttpReply => ({
	status: 200,
	body: JSON.stringify(names.map((name) => ({name}))),
});

/** The directory a plan verb under test is standing in. Its config is the one the load reads. */
export const CWD = "/repo";

/**
 * The context a plan verb needs: the scripted shell, plus a filesystem carrying `config` as this
 * repo's `.fabrika.jsonc` — or carrying none, which is the shipped-vocabulary case every existing
 * test runs in.
 *
 * `unreadable` is its own arm rather than an absent file, because that is the pair the config
 * surface exists to keep apart: absent resolves to the shipped vocabulary, denied leaves the floor
 * UNKNOWN.
 */
export const planContext = (
	shell: {readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>},
	config?: string | {readonly unreadable: true},
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path> => {
	const path = `${CWD}/${CONFIG_PATH}`;
	const files = config === undefined ? {} : {[path]: typeof config === "string" ? config : ""};
	const unreadable = config === undefined || typeof config === "string" ? [] : [path];
	return Layer.merge(shell.layer, fakeFs({files, unreadable}).layer);
};

/** The GitHub reads this group makes over the fetch client, matched on `METHOD url` (ADR 0315). */
const API = "https:\\/\\/api\\.github\\.com";
export const SUB_ISSUES = new RegExp(
	`^GET ${API}\\/repos\\/o\\/r\\/issues\\/${EPIC}\\/sub_issues\\?`,
);
export const CHILD = (number: number): RegExp =>
	new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/issues\\/${number}$`);
/**
 * The cycle-doc probe. Bound to the doc's own path, not to `contents/`: the roster reads
 * `.github/CODEOWNERS` through the same endpoint, and a prefix pattern here answers that read too.
 */
export const CYCLE_DOC = new RegExp(
	`^GET ${API}\\/repos\\/o\\/r\\/contents\\/product-development-cycle\\.md`,
);

/** The cycle doc, served — `present` is any 2xx, and the body is not read. */
export const cycleDoc: HttpReply = {status: 200, body: "{}"};

/** One scripted answer at either seam; which seam it belongs to is read off its own shape. */
export type Scripted = readonly [RegExp, ExecResult] | readonly [RegExp, HttpReply];

const isServed = (entry: Scripted): entry is readonly [RegExp, HttpReply] => "status" in entry[1];

export interface PlanSeams {
	readonly layer: Layer.Layer<
		| ChildProcessSpawner.ChildProcessSpawner
		| FileSystem.FileSystem
		| HttpClient.HttpClient
		| Path.Path
	>;
	readonly shell: FakeShell;
	readonly http: FakeHttp;
}

/**
 * Every seam a plan verb reads through, scripted from **one** list.
 *
 * The list is split by each answer's own shape rather than by the caller sorting it, so a test
 * still reads as the ordered walk the verb makes — splitting it by hand is how a fixture ends up
 * scripted at a seam nobody calls, which fails as "unscripted command" rather than as the thing the
 * test is about.
 */
export const planSeams = (
	script: ReadonlyArray<Scripted>,
	config?: string | {readonly unreadable: true},
): PlanSeams => {
	const shell = fakeShell(
		script.filter((entry): entry is readonly [RegExp, ExecResult] => !isServed(entry)),
	);
	const http = fakeHttp(script.filter(isServed));
	return {layer: Layer.merge(planContext(shell, config), http.layer), shell, http};
};

/** The environment a plan verb test hands its verb — the repo, plus the client's credential. */
export const ENV = {CLAUDE_PIPELINE_REPO: "o/r", GITHUB_TOKEN: "ghp_scripted"} as Record<
	string,
	string | undefined
>;

export const APPROVER = "usirin";

/**
 * The control-plane roster reads the ADR 0289 approval precondition makes before it looks for a
 * marker — the same three `plan approve`'s write resolves the actor through.
 */
export const ROSTER: ReadonlyArray<Scripted> = [
	[new RegExp(`^GET ${API}\\/repos\\/o\\/r$`), {status: 200, body: '{"default_branch":"main"}'}],
	[
		new RegExp(`^GET ${API}\\/repos\\/o\\/r\\/contents\\/\\.github\\/CODEOWNERS\\?ref=main$`),
		{status: 200, body: "/packages/fabrika-cli/ @kamp-us/control-plane\n"},
	],
	[
		new RegExp(`^GET ${API}\\/orgs\\/kamp-us\\/teams\\/control-plane\\/members`),
		{status: 200, body: JSON.stringify([{login: APPROVER}])},
	],
];

/**
 * A standing approval on the epic, as a `comments` row.
 *
 * A row rather than a whole scripted response, because the epic's comments are one read: the claim
 * marker `plan flip` and `plan verdict` prove ownership through arrives in the same payload, and a
 * second scripted `COMMENTS` entry would simply never be reached.
 */
export const approvalRow = (
	digest: string,
	overrides: {id?: number; author?: string; epic?: number} = {},
): {id: number; body: string; author: string} => ({
	id: overrides.id ?? 90,
	body: `plan-approved: #${overrides.epic ?? EPIC} @ ${digest} · 2026-08-16T07:16:03Z\n`,
	author: overrides.author ?? APPROVER,
});

/**
 * The scope digest a ledger script derives, read off `plan read`.
 *
 * `plan read` and not `plan check`, which is the older route: the gate now refuses ahead of its floor
 * on an unapproved plan, so deriving the digest through it would need the very marker the digest is
 * being derived to write.
 */
export const digestOver = async (
	script: ReadonlyArray<Scripted>,
	options: {
		readonly env?: Readonly<Record<string, string | undefined>>;
		readonly config?: string | {readonly unreadable: true} | undefined;
	} = {},
): Promise<string> => {
	const out = await Effect.runPromise(
		Effect.provide(
			runRead({
				number: EPIC,
				repo: null,
				env: options.env ?? ENV,
				cwd: CWD,
			}),
			planSeams(script, options.config).layer,
		),
	);
	// A script the read itself refuses has no digest, and no case that scripts one reaches the gate.
	return out.stdout === "" ? "" : (JSON.parse(out.stdout).digest as string);
};
