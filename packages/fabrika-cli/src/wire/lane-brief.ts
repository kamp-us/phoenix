/**
 * The lane-brief — the bytes a lane driver hands one freshly-spawned fabrika shell.
 *
 * Three fixed sections and nothing else: `## Task` (which lane, which lanes root, which task, which
 * state, which shell), `## Ground` (links and refs, never prose), and `## Rules` (byte-fixed text
 * this module owns).
 *
 * **The lanes root is the one local path a brief carries, and it is in `## Task` because the shell
 * has to address the driver's ledger, not its own.** The default root is relative and every shell
 * runs in its own worktree, so a shell told only the lane id records its terminal into its
 * worktree's `.fabrika/` and the driven lane never hears it (#5736). The root rides inside the
 * format rather than as a line the driver appends under the bytes: an appended line is text the
 * reader below calls malformed, which would turn the byte-fixed guarantee into a budget.
 *
 * **The rules are the format's own bytes, not a driver's phrasing.** A prompt composed per dispatch
 * is a prompt two drivers write differently, and the rule that matters most — carry URLs, never a
 * restatement — is then enforced by nothing but the driver's care. Fixing the bytes here makes the
 * drift unrepresentable rather than detectable.
 *
 * **`## Ground` carries URLs, git refs and no content.** A brief that summarised an issue would hand
 * the shell a stale contract to work from, and the shell has verbs that read the live one.
 *
 * Ground comes in four shapes because an epic run has one branch and one PR (ADR 0285): a child's
 * states have no PR at all — they build in a worktree, and their review judges a commit range the
 * driver's tree resolved — the epic's tail has that one PR plus the epic issue whose children's
 * disclosures its review reads, and every other state has one PR to read. {@link LaneGround} is
 * that union, so a brief carrying both a PR and an epic branch is not a value anyone can construct.
 */

import type {CommitRange} from "../io/git.ts";
import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";
import type {HeadSha} from "./marker-line.ts";
import {parseRange, renderRange} from "./range-verdict-marker.ts";

declare const ARTIFACT_URL: unique symbol;

/** An `https://` artifact link. Branded so a blank or a summary cannot ride in a `Found`. */
export type ArtifactUrl = string & {readonly [ARTIFACT_URL]: true};

export const artifactUrl = (raw: string): ArtifactUrl | null => {
	const value = raw.trim();
	return /^https:\/\/\S+$/.test(value) ? (value as ArtifactUrl) : null;
};

declare const LANES_ROOT: unique symbol;

/**
 * The driver's lanes root, absolute. Branded so a relative path — the default `.fabrika/lanes`,
 * which resolves against whichever worktree the reader happens to stand in — cannot ride in a
 * `Found`.
 */
export type LanesRoot = string & {readonly [LANES_ROOT]: true};

export const lanesRoot = (raw: string): LanesRoot | null => {
	const value = raw.trim();
	if (!value.startsWith("/")) return null;
	return value.split("/").includes("..") ? null : (value as LanesRoot);
};

declare const GIT_REF: unique symbol;

/** A git ref name. Branded so a URL, a range, or a flag-shaped word cannot ride in one. */
export type GitRef = string & {readonly [GIT_REF]: true};

export const gitRef = (raw: string): GitRef | null => {
	const value = raw.trim();
	return /^[A-Za-z0-9][\w./-]*$/.test(value) && !value.includes("..") ? (value as GitRef) : null;
};

/** The assembly branch of one epic run — one branch and one PR per run (ADR 0285). */
export const epicBranch = (epic: number): GitRef => `epic/${epic}` as GitRef;

/**
 * The range a child's review judges: two commits the *driver's* tree already resolved.
 *
 * Both endpoints are concrete because the far end used to be `HEAD` — and `HEAD` is resolved by the
 * spawned reviewer, in a worktree cut fresh from the driver's checkout, where it stands on the
 * assembly branch rather than on the child's build branch. The range read as empty there, so the
 * gate judged nothing and could still land a verdict (#6023). The grammar is the range-verdict
 * marker's own, so the range a reviewer is briefed with is spelled exactly like the verdict it
 * records over it.
 */
export type ReviewRange = CommitRange<HeadSha>;

/** The three leaf states that route to a shell. Every other state is a refusal, never a guess. */
export const SHELL_STATES = ["build", "review", "ship"] as const;

export type ShellState = (typeof SHELL_STATES)[number];

export type LaneShell = "builder" | "reviewer" | "shipper";

const SHELLS: Readonly<Record<ShellState, LaneShell>> = {
	build: "builder",
	review: "reviewer",
	ship: "shipper",
};

/** The state → shell table, total over the states that route — owned here, not in the verb. */
export const shellOf = (state: ShellState): LaneShell => SHELLS[state];

/**
 * A leaf state, only if it routes to a shell.
 *
 * `null` for every other one — `queued`, `blocked`, `human:*`, a name nobody recognises — which is
 * what makes "guess a shell for an unrouted state" unwritable rather than merely discouraged.
 */
export const shellState = (raw: string): ShellState | null => {
	const value = raw.trim();
	return (SHELL_STATES as ReadonlyArray<string>).includes(value) ? (value as ShellState) : null;
};

/**
 * What the shell works over.
 *
 * `Pull` is a single-issue lane's state — one PR to read, `null` only on `build`, where
 * construction has none yet. `Tail` is an epic lane's tail: the run's one PR, plus the epic issue
 * whose children's `build-deviations` comments the tail review reads. `Epic` is a child's `build`:
 * the epic issue, the assembly branch its worktree is cut from, and no PR, because a child never
 * opens one. `EpicRange` is a child's `review`, which is that same ground plus the resolved range
 * to judge — two tags rather than one optional field, so a review brief with no range is a value
 * nobody can construct, and a `build` brief can never carry a half-filled one (#6023).
 */
export type LaneGround =
	| {readonly _tag: "Pull"; readonly pr: ArtifactUrl | null}
	| {readonly _tag: "Tail"; readonly pr: ArtifactUrl; readonly epic: ArtifactUrl}
	| {readonly _tag: "Epic"; readonly epic: ArtifactUrl; readonly branch: GitRef}
	| {
			readonly _tag: "EpicRange";
			readonly epic: ArtifactUrl;
			readonly branch: GitRef;
			readonly range: ReviewRange;
	  };

export interface LaneBrief {
	/** The lane id as the store names it — by convention the driven issue number. */
	readonly lane: string;
	/** The absolute lanes root the shell passes back to `lane report` as `--root`. */
	readonly root: LanesRoot;
	/** The task the state belongs to, exactly as `lane status` prints it. */
	readonly task: string;
	readonly state: ShellState;
	readonly shell: LaneShell;
	readonly issue: ArtifactUrl;
	readonly ground: LaneGround;
}

export type LaneBriefRead = WireRead<LaneBrief>;

/**
 * The `## Rules` text, byte-fixed and owned by the format.
 *
 * Each sentence is a rule a driver used to carry in their own prose: worktree isolation, URLs over
 * restatements, and the in-tree entrypoint with the reason it exists (#5679).
 */
export const RULES = `Run in your own git worktree; a shell that shares the primary checkout can mutate its git state.
Work from the URLs above and never from a summary of them — read the issue, the PR and its verdicts
through your own verbs, because a restated spec is a stale spec.
Invoke every fabrika verb as \`node packages/fabrika-cli/src/bin.ts <group> <verb>\`, never the bare
\`fabrika\` binstub: in a worktree it resolves to another checkout's code (#5679), so its answer
describes a tree you are not standing in.`;

/**
 * The rules an epic lane's child state adds, byte-fixed the same way and appended to {@link RULES}.
 *
 * Which text a brief carries is structural — an `Epic` ground carries both, a `Pull` ground carries
 * only the first — so this stays a fixed pair of texts rather than a per-dispatch choice.
 */
export const EPIC_RULES = `This lane is one epic run: one shared branch and one pull request at its tail (ADR 0285). Build in
your own worktree on a local branch cut from \`branch\`, and never push or open a pull request for a
child state — the merge happens once, after the epic review. A child's build that lands its commit
ends on \`BUILT-NO-PR\`, whose branch disposition is exactly that: left local and unpushed for this
lane to fold (#6019).
A child's build discloses its deviations — the section a PR body would carry — as a
\`build-deviations\` marker comment on the child issue, composed through
\`node packages/fabrika-cli/src/bin.ts wire emit --format build-deviations\`; the epic-tail review
reads them from there (#5903).
A child's review judges the \`range\` above and records its verdict on the child issue in the
\`range-verdict-marker\` format, composed through
\`node packages/fabrika-cli/src/bin.ts wire emit --format range-verdict-marker\`.`;

/**
 * The rules an epic run's tail adds — the counterpart of {@link EPIC_RULES}, appended when the
 * ground is `Tail`. This is where the tail review is told where each child's deviation disclosure
 * lives (#5903): the brief is the one artifact every tail shell provably reads.
 */
export const EPIC_TAIL_RULES = `This PR is one epic run's tail: its branch assembles every child's range (ADR 0285), and its
\`## Deviations\` section covers only that assembly. Each landed child disclosed its own build
deviations as a \`build-deviations\` marker comment on its child issue — the issues the PR body's
closing references name. The tail review reads every one of them through
\`node packages/fabrika-cli/src/bin.ts wire read --format build-deviations\` before forming its
verdict.`;

/** The section headings this format admits, in the order it emits them. */
export const SECTIONS = ["Task", "Ground", "Rules"] as const;

/** The `## Ground` fields a ground carries, after the `issue` every brief has. */
const groundFields = (brief: LaneBrief): ReadonlyArray<readonly [string, string]> => {
	if (brief.ground._tag === "Pull") {
		return brief.ground.pr === null ? [] : [["pr", brief.ground.pr]];
	}
	if (brief.ground._tag === "Tail") {
		return [
			["pr", brief.ground.pr],
			["epic", brief.ground.epic],
		];
	}
	const {epic, branch} = brief.ground;
	return [
		["epic", epic],
		["branch", branch],
		...(brief.ground._tag === "EpicRange"
			? [["range", renderRange(brief.ground.range)] as const]
			: []),
	];
};

const rulesFor = (ground: LaneGround): string => {
	if (ground._tag === "Pull") return RULES;
	return ground._tag === "Tail" ? `${RULES}\n${EPIC_TAIL_RULES}` : `${RULES}\n${EPIC_RULES}`;
};

export const emit = (brief: LaneBrief): string =>
	[
		"## Task",
		`lane: ${brief.lane}`,
		`root: ${brief.root}`,
		`task: ${brief.task}`,
		`state: ${brief.state}`,
		`shell: ${brief.shell}`,
		"## Ground",
		`issue: ${brief.issue}`,
		...groundFields(brief).map(([key, value]) => `${key}: ${value}`),
		"## Rules",
		rulesFor(brief.ground),
		"",
	].join("\n");

const malformed = (reason: string, evidence: string): LaneBriefRead => ({
	_tag: "Malformed",
	reason,
	evidence,
});

const HEADING = /^##\s+(.*\S)\s*$/;
const FIELD = /^([a-z-]+):\s*(.*)$/;

interface Section {
	readonly name: string;
	readonly lines: ReadonlyArray<string>;
}

interface Scan {
	readonly sections: ReadonlyArray<Section>;
	/** The first non-blank line before any heading: text that instructs outside every section. */
	readonly stray: string | null;
}

const sectionsOf = (artifact: string): Scan => {
	const sections: {name: string; lines: string[]}[] = [];
	let stray: string | null = null;
	for (const raw of artifact.split("\n")) {
		const heading = HEADING.exec(raw);
		if (heading?.[1] !== undefined) {
			sections.push({name: heading[1], lines: []});
			continue;
		}
		const current = sections.at(-1);
		if (current === undefined) {
			if (raw.trim() !== "" && stray === null) stray = raw.trim();
			continue;
		}
		current.lines.push(raw);
	}
	return {sections, stray};
};

const trimmed = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
	const out = [...lines];
	while (out.length > 0 && (out.at(-1) ?? "").trim() === "") out.pop();
	return out;
};

type FieldScan =
	| {readonly _tag: "Fields"; readonly fields: ReadonlyMap<string, string>}
	| {readonly _tag: "NotAField"; readonly line: string};

const fieldsOf = (sections: ReadonlyArray<Section>): FieldScan => {
	const fields = new Map<string, string>();
	for (const section of sections) {
		for (const line of section.lines) {
			if (line.trim() === "") continue;
			const field = FIELD.exec(line.trim());
			if (field?.[1] === undefined) return {_tag: "NotAField", line: line.trim()};
			fields.set(field[1], field[2] ?? "");
		}
	}
	return {_tag: "Fields", fields};
};

type GroundScan =
	| {readonly _tag: "Ground"; readonly ground: LaneGround}
	| {readonly _tag: "Bad"; readonly reason: string; readonly field: string};

const bad = (reason: string, field: string): GroundScan => ({_tag: "Bad", reason, field});

/**
 * Which ground the fields carry, and whether the state may stand on it — the one reader both `read`
 * and {@link parseFields} go through, so a brief cannot be composable and unreadable at once.
 */
const groundOf = (fields: ReadonlyMap<string, string>, state: ShellState): GroundScan => {
	const value = (key: string): string => (fields.get(key) ?? "").trim();
	const prRaw = value("pr");
	const epicRaw = value("epic");
	const branchRaw = value("branch");
	const rangeRaw = value("range");
	if (epicRaw === "" && branchRaw === "" && rangeRaw === "") {
		const pr = prRaw === "" ? null : artifactUrl(prRaw);
		if (pr === null && prRaw !== "") return bad(`"${prRaw}" is not a PR URL`, "pr");
		// A reviewer or shipper with no PR has nothing to judge or merge, so the brief that would send
		// one is not a well-formed brief — the ambiguity is the driver's to resolve before dispatch.
		if (pr === null && state !== "build") {
			return bad(`a "${state}" brief carries no PR URL — that shell has nothing to read`, "pr");
		}
		return {_tag: "Ground", ground: {_tag: "Pull", pr}};
	}
	const epic = artifactUrl(epicRaw);
	if (epic === null) return bad(`"${epicRaw}" is not an epic issue URL`, "epic");
	if (branchRaw === "" && rangeRaw === "") {
		// The epic run's tail: one PR to judge or merge, plus the epic whose children's
		// `build-deviations` comments the tail review reads.
		const pr = artifactUrl(prRaw);
		if (pr === null) {
			return bad(
				prRaw === ""
					? "a tail brief carries the run's one PR — without it the shell has nothing to read"
					: `"${prRaw}" is not a PR URL`,
				"pr",
			);
		}
		if (state === "build") {
			return bad(
				"an epic tail briefs review or ship — construction happens in the children",
				"state",
			);
		}
		return {_tag: "Ground", ground: {_tag: "Tail", pr, epic}};
	}
	if (prRaw !== "") {
		return bad(
			"an epic lane's child state has no PR — one run is one PR, merged at its tail",
			"pr",
		);
	}
	const branch = gitRef(branchRaw);
	if (branch === null) return bad(`"${branchRaw}" is not a branch name`, "branch");
	if (state === "ship") {
		return bad("a child state never ships — an epic run merges once, at its tail", "state");
	}
	if (state !== "review") {
		return rangeRaw === ""
			? {_tag: "Ground", ground: {_tag: "Epic", epic, branch}}
			: bad(`a "${state}" brief names a range, and nothing has landed for one to judge`, "range");
	}
	if (rangeRaw === "") {
		return bad("a child review judges a range, and this brief names none", "range");
	}
	const range = parseRange(rangeRaw);
	if (range === null) {
		return bad(
			`"${rangeRaw}" is not a range of two resolved revisions — an endpoint the spawned shell re-resolves is the defect this field exists to delete (#6023)`,
			"range",
		);
	}
	return {_tag: "Ground", ground: {_tag: "EpicRange", epic, branch, range}};
};

/** Read a brief. Total: `Found` | `Absent` | `Malformed`. */
export const read = (artifact: string): LaneBriefRead => {
	const {sections, stray} = sectionsOf(artifact);
	// Stray text is a *drift* only once the bytes reach for this format at all. Bytes carrying no
	// section are simply not a brief, and reporting those as malformed would make every unrelated
	// comment a defective one.
	if (sections.find((section) => section.name === "Task") === undefined) {
		return {_tag: "Absent", reason: 'no "## Task" section — these bytes are not a lane brief'};
	}
	if (stray !== null) {
		return malformed(
			"the brief carries text outside its sections — a brief instructs only through them",
			`"${stray}"`,
		);
	}

	const unknown = sections.find(
		(section) => !(SECTIONS as ReadonlyArray<string>).includes(section.name),
	);
	if (unknown !== undefined) {
		return malformed(
			`"## ${unknown.name}" is not a section of this format — a brief instructs only through its three fixed sections`,
			`"## ${unknown.name}"`,
		);
	}

	const task = sections.find((section) => section.name === "Task");
	const ground = sections.find((section) => section.name === "Ground");
	const rules = sections.find((section) => section.name === "Rules");
	if (task === undefined || ground === undefined || rules === undefined) {
		return malformed(
			'a brief carries "## Task", "## Ground" and "## Rules" — one of them is missing',
			sections.map((section) => `## ${section.name}`).join(" | "),
		);
	}

	const scan = fieldsOf([task, ground]);
	if (scan._tag === "NotAField") {
		return malformed(`a section carries a line that is not a field: "${scan.line}"`, scan.line);
	}
	const fields = scan.fields;

	const laneRaw = (fields.get("lane") ?? "").trim();
	if (laneRaw === "") return malformed("the brief names no lane", "lane");
	const root = lanesRoot(fields.get("root") ?? "");
	if (root === null) {
		return malformed(
			`"${(fields.get("root") ?? "").trim()}" is not an absolute lanes root — a relative one resolves against the shell's own worktree, never the driven lane`,
			"root",
		);
	}
	const taskName = (fields.get("task") ?? "").trim();
	if (taskName === "") return malformed("the brief names no task", "task");
	const state = shellState(fields.get("state") ?? "");
	if (state === null) {
		return malformed(
			`"${(fields.get("state") ?? "").trim()}" is not a state that routes to a shell (${SHELL_STATES.join("/")})`,
			"state",
		);
	}
	const shell = SHELLS[state];
	if ((fields.get("shell") ?? "").trim() !== shell) {
		return malformed(
			`"${(fields.get("shell") ?? "").trim()}" is not the shell state "${state}" routes to`,
			"shell",
		);
	}
	const issue = artifactUrl(fields.get("issue") ?? "");
	if (issue === null) {
		return malformed(`"${(fields.get("issue") ?? "").trim()}" is not an issue URL`, "issue");
	}
	const scanned = groundOf(fields, state);
	if (scanned._tag === "Bad") return malformed(scanned.reason, scanned.field);

	// The rules are checked against the ground's own text, so a child brief carrying only the
	// single-issue rules — the shape that would let a child push and open its own PR — is malformed.
	const expected = rulesFor(scanned.ground);
	if (trimmed(rules.lines).join("\n") !== expected) {
		return malformed(
			'"## Rules" does not carry this format\'s own text — the rules are byte-fixed, so an edited one is not a brief',
			trimmed(rules.lines).join("\n"),
		);
	}

	return {
		_tag: "Found",
		value: {lane: laneRaw, root, task: taskName, state, shell, issue, ground: scanned.ground},
	};
};

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderBrief = (brief: LaneBrief): NonEmptyReadonlyArray<string> => [
	`lane\t${brief.lane}`,
	`root\t${brief.root}`,
	`task\t${brief.task}`,
	`state\t${brief.state}`,
	`shell\t${brief.shell}`,
	`issue\t${brief.issue}`,
	...groundFields(brief).map(([key, value]) => `${key}\t${value}`),
];

export type LaneBriefFields =
	| {readonly _tag: "Fields"; readonly brief: LaneBrief}
	| {readonly _tag: "Unusable"; readonly reason: string};

/**
 * Parse `emit`'s stdin: one `<key>: <value>` per line.
 *
 * `shell` is derived from `state` rather than accepted, so a caller cannot compose a brief whose
 * shell and state disagree — the routing table has one reader.
 */
export const parseFields = (fields: string): LaneBriefFields => {
	const values = new Map<string, string>();
	for (const [index, raw] of fields.split("\n").entries()) {
		const line = raw.trim();
		if (line === "") continue;
		const field = FIELD.exec(line);
		if (field?.[1] === undefined) {
			return {_tag: "Unusable", reason: `line ${index + 1} is not a "<field>: <value>" line`};
		}
		values.set(field[1], field[2] ?? "");
	}

	const laneRaw = (values.get("lane") ?? "").trim();
	const root = lanesRoot(values.get("root") ?? "");
	const task = (values.get("task") ?? "").trim();
	const state = shellState(values.get("state") ?? "");
	const issue = artifactUrl(values.get("issue") ?? "");
	if (laneRaw === "") return {_tag: "Unusable", reason: "no lane id"};
	if (root === null) return {_tag: "Unusable", reason: "no absolute lanes root"};
	if (task === "") return {_tag: "Unusable", reason: "no task name"};
	if (state === null) {
		return {_tag: "Unusable", reason: `no shell state (${SHELL_STATES.join("/")})`};
	}
	if (issue === null) return {_tag: "Unusable", reason: "no issue URL"};
	const scanned = groundOf(values, state);
	if (scanned._tag === "Bad") return {_tag: "Unusable", reason: scanned.reason};
	return {
		_tag: "Fields",
		brief: {lane: laneRaw, root, task, state, shell: SHELLS[state], issue, ground: scanned.ground},
	};
};

/** The registry row's byte-level `emit`, bound to this module's typed core. */
export const emitFromFields = (fields: string): WireEmit => {
	const parsed = parseFields(fields);
	return parsed._tag === "Fields"
		? {_tag: "Composed", bytes: emit(parsed.brief)}
		: {_tag: "Unusable", reason: parsed.reason};
};

/** The registry row's byte-level `read`, bound to this module's typed core. */
export const readToLines = (artifact: string): WireReadLines => {
	const result = read(artifact);
	return result._tag === "Found" ? {_tag: "Found", value: renderBrief(result.value)} : result;
};
