/**
 * standup/toolset-assert — the pre-launch declared-vs-actual seat toolset assert (issue #3764). A crew
 * seat boots as `claude --agent crew-<role>`, so its agent-def `tools:` allowlist is the only gate on
 * what the seat can call (CHANNEL-TOOL.md) — but the CLI resolves that declaration SILENTLY: a name it
 * cannot grant is dropped with no warning and no error, so the seat comes up degraded with nothing to
 * notice. Three bridge seats ran a whole session that way: their defs declared `Task`/`Grep`/`Glob` and
 * they booted with `Read`/`Bash`, leaving the charter's "spawn the planner" obligation and the ADR 0196
 * read-only fanout structurally unreachable.
 *
 * Two silent-drop rules, both established against the installed CLI 2.1.217 by booting probe agent-defs
 * under `--output-format stream-json` and reading the `init` event's `tools` array (the same probe
 * re-derives them on a version bump):
 *
 *   1. SELF-DENIAL — a `disallowedTools` entry is matched by its BASE tool name; the `(specifier)` is
 *      IGNORED and the WHOLE tool is subtracted from `tools:`. `disallowedTools: ["Task(coder)"]` does
 *      not deny the `coder` subagent, it deletes `Task` (probe: `tools:[Read,Bash,Task]` +
 *      `disallowedTools:[Task(coder)]` → `[Read,Bash]`; `[Bash(rm:*)]` → `[Read,Task]`). There is no
 *      per-subagent deny at this layer at all: a `permissions: {deny: ["Task(x)"]}` frontmatter key
 *      leaves the tool in place AND does not block the spawn, so a "which agents may this seat spawn"
 *      restriction is a charter rule the def states in prose, never a mechanism.
 *   2. UNGRANTABLE NAME — a declared name outside `GRANTABLE_SESSION_TOOLS` is dropped. `Grep` and
 *      `Glob` are not tools a top-level session is granted on this CLI at all, so declaring them is a
 *      no-op that reads like a grant.
 *
 * The one non-obvious thing: this FAILS CLOSED like every other launcher precondition (version-assert,
 * bind's three refusals) — a declaration that would not resolve intact refuses the launch with a named
 * error carrying the role, the dropped names, and which rule dropped them, rather than booting a
 * silently degraded seat. It runs before the tracker and any session, so a mis-declared seat costs zero
 * panes. Scope is the seats the launcher launches (the roster's top-level `--agent` defs); a subagent
 * def's toolset is resolved by whichever session spawns it, not by this launcher.
 */
import {Effect, FileSystem, Path, Schema} from "effect";
import type {CrewRole} from "../crew/index.ts";
import {CREW_PLUGIN_SUBDIR} from "./bind.ts";

/**
 * The tool names a top-level `claude --agent` session can actually be granted. Read off the `init`
 * event of a default (no-`--agent`) session on the pinned CLI 2.1.217 — a CLI-version-scoped fact of the
 * same class as the `cliVersion` pin, so a version bump re-derives it with:
 * `claude -p hi --output-format stream-json --verbose --max-turns 1` → the `system`/`init` event's `tools`.
 * MCP tokens are excluded on purpose (see `isMcpToolToken`).
 */
export const GRANTABLE_SESSION_TOOLS: ReadonlySet<string> = new Set([
	"Bash",
	"CronCreate",
	"CronDelete",
	"CronList",
	"DesignSync",
	"Edit",
	"EnterWorktree",
	"ExitWorktree",
	"LSP",
	"Monitor",
	"NotebookEdit",
	"PushNotification",
	"Read",
	"RemoteTrigger",
	"ReportFindings",
	"ScheduleWakeup",
	"SendMessage",
	"Skill",
	"Task",
	"TaskCreate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",
	"TaskUpdate",
	"ToolSearch",
	"WebFetch",
	"WebSearch",
	"Workflow",
	"Write",
]);

/**
 * An MCP tool token (`mcp__<sanitized server>__<tool>`) is exempt from the grantable check: it is
 * served by a connected MCP server rather than the CLI's own registry, so its absence at boot is the
 * channel's connect window (CHANNEL-TOOL.md), not a declaration error.
 */
export const isMcpToolToken = (entry: string): boolean => entry.startsWith("mcp__");

/** The tool a `tools:`/`disallowedTools:` entry names, with any `(specifier)` stripped — the CLI's own match key (rule 1). */
export const baseToolName = (entry: string): string => (entry.split("(")[0] ?? entry).trim();

/**
 * What a def declares about its toolset. `inherit` is the no-`tools:`-key def — the CLI grants its
 * default toolset and there is no allowlist to silently narrow, so there is nothing to assert.
 */
export type DeclaredToolset =
	| {readonly _tag: "inherit"}
	| {
			readonly _tag: "allowlist";
			readonly tools: readonly string[];
			readonly disallowedTools: readonly string[];
	  };

/** What the CLI would actually grant a seat from its declaration, and what each silent-drop rule took. */
export interface ToolsetResolution {
	readonly granted: readonly string[];
	/** Declared names the CLI cannot grant at all (rule 2). */
	readonly ungrantable: readonly string[];
	/** Declared names subtracted by the def's own `disallowedTools` base-name match (rule 1). */
	readonly selfDenied: readonly string[];
}

/** Resolve a declaration through both silent-drop rules — the pure core the assert and its tests share. */
export const resolveDeclaredToolset = (declared: DeclaredToolset): ToolsetResolution => {
	if (declared._tag === "inherit") return {granted: [], ungrantable: [], selfDenied: []};
	const denied = new Set(declared.disallowedTools.map(baseToolName));
	const granted: string[] = [];
	const ungrantable: string[] = [];
	const selfDenied: string[] = [];
	for (const entry of declared.tools) {
		const base = baseToolName(entry);
		if (!isMcpToolToken(entry) && !GRANTABLE_SESSION_TOOLS.has(base)) ungrantable.push(entry);
		else if (denied.has(base)) selfDenied.push(entry);
		else granted.push(entry);
	}
	return {granted, ungrantable, selfDenied};
};

/**
 * A seat's def declares a toolset the CLI would not resolve intact — the launch to refuse. Carries which
 * names go and under which rule, so the operator can fix the def without re-running the boot probe.
 */
export class CrewSeatToolsetMismatchError extends Schema.TaggedErrorClass<CrewSeatToolsetMismatchError>()(
	"@kampus/pipeline-crew-mcp/standup/CrewSeatToolsetMismatchError",
	{
		role: Schema.String,
		defPath: Schema.String,
		ungrantable: Schema.Array(Schema.String),
		selfDenied: Schema.Array(Schema.String),
		reason: Schema.String,
	},
) {}

/**
 * A seat's def could not be read, or its `tools:`/`disallowedTools:` is present in a shape this reader
 * does not parse. Refusing beats skipping: an unparsed declaration is precisely the silent degradation
 * the assert exists to catch.
 */
export class CrewSeatDefUnreadableError extends Schema.TaggedErrorClass<CrewSeatDefUnreadableError>()(
	"@kampus/pipeline-crew-mcp/standup/CrewSeatDefUnreadableError",
	{
		role: Schema.String,
		defPath: Schema.String,
		reason: Schema.String,
	},
) {}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** A `key: ["a", "b"]` flow sequence on one line — the shape every crew def writes and this parser accepts. */
const flowLineOf = (key: string) => new RegExp(`^${key}:[ \\t]*(\\[[^\\n]*\\])[ \\t]*\\r?$`, "m");
const anyLineOf = (key: string) => new RegExp(`^${key}:`, "m");

/** One `"Name"` element. Total by construction, so no throwing `JSON.parse` is needed to read the list. */
const QUOTED_ENTRY_RE = /^"([^"\\]*)"$/;

type FieldParse =
	| {readonly _tag: "absent"}
	| {readonly _tag: "entries"; readonly entries: readonly string[]}
	| {readonly _tag: "unparsed"};

/** Split `["A", "B"]` into its names, or null on anything else. Safe on `,`: no tool name contains one. */
const flowEntriesOf = (literal: string): readonly string[] | null => {
	const inner = literal.slice(1, -1).trim();
	if (inner.length === 0) return [];
	const out: string[] = [];
	for (const part of inner.split(",")) {
		const name = QUOTED_ENTRY_RE.exec(part.trim())?.[1];
		if (name === undefined) return null;
		out.push(name);
	}
	return out;
};

const parseField = (frontmatter: string, key: string): FieldParse => {
	const literal = frontmatter.match(flowLineOf(key))?.[1];
	if (literal === undefined) {
		return anyLineOf(key).test(frontmatter) ? {_tag: "unparsed"} : {_tag: "absent"};
	}
	const entries = flowEntriesOf(literal);
	return entries === null ? {_tag: "unparsed"} : {_tag: "entries", entries};
};

/** Parse a def's declared toolset out of its YAML frontmatter, or `null` when it is present in an unparsed shape. */
export const parseDeclaredToolset = (source: string): DeclaredToolset | null => {
	const frontmatter = source.match(FRONTMATTER_RE)?.[1];
	if (frontmatter === undefined) return null;
	const tools = parseField(frontmatter, "tools");
	const disallowed = parseField(frontmatter, "disallowedTools");
	if (tools._tag === "unparsed" || disallowed._tag === "unparsed") return null;
	if (tools._tag === "absent") return {_tag: "inherit"};
	return {
		_tag: "allowlist",
		tools: tools.entries,
		disallowedTools: disallowed._tag === "entries" ? disallowed.entries : [],
	};
};

/** The repo-relative def a seat boots from — the `--agent crew-<role>` target under bind's `--plugin-dir`. */
export const seatDefRelativePath = (role: CrewRole): string =>
	`${CREW_PLUGIN_SUBDIR}/agents/crew-${role}.md`;

/**
 * Reads one seat's declared toolset. Injected so the launch composition stays unit-testable with no
 * real def on disk — hence `R`: the production reader carries the platform seam, a test stub carries
 * `never`, and the assert's own context is whatever its reader needs rather than always the platform.
 */
export type SeatToolsetReader<R = FileSystem.FileSystem | Path.Path> = (
	projectRoot: string,
	role: CrewRole,
) => Effect.Effect<DeclaredToolset, CrewSeatDefUnreadableError, R>;

/** The production reader: parse the seat's agent def under the launched `--plugin-dir`. */
export const readSeatToolsetFromDef: SeatToolsetReader = (projectRoot, role) =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const defPath = path.join(projectRoot, seatDefRelativePath(role));
		const fs = yield* FileSystem.FileSystem;
		const source = yield* fs.readFileString(defPath).pipe(
			Effect.mapError(
				(cause) =>
					new CrewSeatDefUnreadableError({
						role,
						defPath,
						reason: `cannot read: ${String(cause)}`,
					}),
			),
		);
		const declared = parseDeclaredToolset(source);
		if (declared === null) {
			return yield* new CrewSeatDefUnreadableError({
				role,
				defPath,
				reason:
					"no YAML frontmatter, or a `tools:`/`disallowedTools:` that is not a single-line flow sequence of double-quoted names — the assert refuses rather than skip an unparsed declaration",
			});
		}
		return declared;
	});

/** Refuse when a seat's declaration would not resolve intact — the pure decision, separate from the read. */
export const assertSeatToolset = (
	role: CrewRole,
	defPath: string,
	declared: DeclaredToolset,
): Effect.Effect<void, CrewSeatToolsetMismatchError> => {
	const {ungrantable, selfDenied} = resolveDeclaredToolset(declared);
	if (ungrantable.length === 0 && selfDenied.length === 0) return Effect.void;
	const parts = [
		ungrantable.length > 0
			? `${JSON.stringify(ungrantable)} name no tool this CLI grants a top-level session, so they are silently dropped`
			: undefined,
		selfDenied.length > 0
			? `${JSON.stringify(selfDenied)} are subtracted by this def's own \`disallowedTools\` (an entry matches by BASE tool name — the \`(specifier)\` is ignored and the WHOLE tool goes)`
			: undefined,
	].filter((part) => part !== undefined);
	return Effect.fail(
		new CrewSeatToolsetMismatchError({
			role,
			defPath,
			ungrantable,
			selfDenied,
			reason: `the "${role}" seat would boot without tools its def declares: ${parts.join("; ")} — fix the def rather than boot a silently degraded seat`,
		}),
	);
};

/**
 * Assert every named seat's declaration resolves intact, before the tracker or any session comes up.
 * Serial (`concurrency: 1`) so the first mis-declared seat is the one named, deterministically.
 */
export const assertCrewSeatToolsets = <R = FileSystem.FileSystem | Path.Path>(
	projectRoot: string,
	roles: readonly CrewRole[],
	read: SeatToolsetReader<R>,
): Effect.Effect<void, CrewSeatToolsetMismatchError | CrewSeatDefUnreadableError, R> =>
	Effect.forEach(
		roles,
		(role) =>
			Effect.gen(function* () {
				const declared = yield* read(projectRoot, role);
				yield* assertSeatToolset(role, seatDefRelativePath(role), declared);
			}),
		{concurrency: 1, discard: true},
	);
