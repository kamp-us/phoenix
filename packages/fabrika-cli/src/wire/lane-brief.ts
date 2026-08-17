/**
 * The lane-brief — the bytes a lane driver hands one freshly-spawned fabrika shell.
 *
 * Three fixed sections and nothing else: `## Task` (which lane, which task, which state, which
 * shell), `## Ground` (the URLs, and only URLs), and `## Rules` (byte-fixed text this module owns).
 *
 * **The rules are the format's own bytes, not a driver's phrasing.** A prompt composed per dispatch
 * is a prompt two drivers write differently, and the rule that matters most — carry URLs, never a
 * restatement — is then enforced by nothing but the driver's care. Fixing the bytes here makes the
 * drift unrepresentable rather than detectable.
 *
 * **`## Ground` carries URLs and no content.** A brief that summarised an issue would hand the shell
 * a stale contract to work from, and the shell has verbs that read the live one.
 */

import type {NonEmptyReadonlyArray, WireEmit, WireRead, WireReadLines} from "./format.ts";

declare const ARTIFACT_URL: unique symbol;

/** An `https://` artifact link. Branded so a blank or a summary cannot ride in a `Found`. */
export type ArtifactUrl = string & {readonly [ARTIFACT_URL]: true};

export const artifactUrl = (raw: string): ArtifactUrl | null => {
	const value = raw.trim();
	return /^https:\/\/\S+$/.test(value) ? (value as ArtifactUrl) : null;
};

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

export interface LaneBrief {
	/** The lane id as the store names it — by convention the driven issue number. */
	readonly lane: string;
	/** The task the state belongs to, exactly as `lane status` prints it. */
	readonly task: string;
	readonly state: ShellState;
	readonly shell: LaneShell;
	readonly issue: ArtifactUrl;
	/** The lane's open PR. `null` only on `build`, where construction has none yet. */
	readonly pr: ArtifactUrl | null;
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

/** The section headings this format admits, in the order it emits them. */
export const SECTIONS = ["Task", "Ground", "Rules"] as const;

export const emit = (brief: LaneBrief): string =>
	[
		"## Task",
		`lane: ${brief.lane}`,
		`task: ${brief.task}`,
		`state: ${brief.state}`,
		`shell: ${brief.shell}`,
		"## Ground",
		`issue: ${brief.issue}`,
		...(brief.pr === null ? [] : [`pr: ${brief.pr}`]),
		"## Rules",
		RULES,
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

	if (trimmed(rules.lines).join("\n") !== RULES) {
		return malformed(
			'"## Rules" does not carry this format\'s own text — the rules are byte-fixed, so an edited one is not a brief',
			trimmed(rules.lines).join("\n"),
		);
	}

	const scan = fieldsOf([task, ground]);
	if (scan._tag === "NotAField") {
		return malformed(`a section carries a line that is not a field: "${scan.line}"`, scan.line);
	}
	const fields = scan.fields;

	const laneRaw = (fields.get("lane") ?? "").trim();
	if (laneRaw === "") return malformed("the brief names no lane", "lane");
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
	const prRaw = (fields.get("pr") ?? "").trim();
	const pr = prRaw === "" ? null : artifactUrl(prRaw);
	if (pr === null && prRaw !== "") return malformed(`"${prRaw}" is not a PR URL`, "pr");
	// A reviewer or shipper with no PR has nothing to judge or merge, so the brief that would send
	// one is not a well-formed brief — the ambiguity is the driver's to resolve before dispatch.
	if (pr === null && state !== "build") {
		return malformed(`a "${state}" brief carries no PR URL — that shell has nothing to read`, "pr");
	}

	return {
		_tag: "Found",
		value: {lane: laneRaw, task: taskName, state, shell, issue, pr},
	};
};

/** One `<field>\t<value>` line per field — the `wire read` answer for this format. */
export const renderBrief = (brief: LaneBrief): NonEmptyReadonlyArray<string> => [
	`lane\t${brief.lane}`,
	`task\t${brief.task}`,
	`state\t${brief.state}`,
	`shell\t${brief.shell}`,
	`issue\t${brief.issue}`,
	...(brief.pr === null ? [] : [`pr\t${brief.pr}`]),
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
	const task = (values.get("task") ?? "").trim();
	const state = shellState(values.get("state") ?? "");
	const issue = artifactUrl(values.get("issue") ?? "");
	const prRaw = (values.get("pr") ?? "").trim();
	const pr = prRaw === "" ? null : artifactUrl(prRaw);
	if (laneRaw === "") return {_tag: "Unusable", reason: "no lane id"};
	if (task === "") return {_tag: "Unusable", reason: "no task name"};
	if (state === null) {
		return {_tag: "Unusable", reason: `no shell state (${SHELL_STATES.join("/")})`};
	}
	if (issue === null) return {_tag: "Unusable", reason: "no issue URL"};
	if (pr === null && prRaw !== "") return {_tag: "Unusable", reason: "no PR URL"};
	if (pr === null && state !== "build") {
		return {_tag: "Unusable", reason: `a "${state}" brief needs a PR URL`};
	}
	return {
		_tag: "Fields",
		brief: {lane: laneRaw, task, state, shell: SHELLS[state], issue, pr},
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
