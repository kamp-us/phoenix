/**
 * The config-change dispatch proof's config layer: one `claude-session` row over
 * `ScriptedAiAgent`, plus a second row that declares no `configChanged` at all.
 *
 * What each generation holds is read at import out of the JSON file
 * `TUVAL_CLAUDE_RELOAD_FIXTURE` names, exactly as `./reloadable.ts` reads its own — so rewriting
 * that file and loading the config again is a genuine config change, and the module itself stays
 * put. `other` is here so a reload can be watched *not* reaching a process, and `drop` leaves the
 * claude row out entirely, which is the generation a running process has no replacement row in.
 */

import {readFileSync} from "node:fs";
import {defineMachine} from "@demlik/tea";
import {Effect} from "effect";
import {Mode} from "../ai-agent/ports/index.ts";
import {ScriptedAiAgent} from "../ai-agent/service/index.ts";
import type {AgentScript} from "../ai-agent/service/script.ts";
import type {ClaudeSessionConfigInput} from "../claude/config.ts";
import {CLAUDE_SESSION_PROGRAM, claudeSession} from "../claude/program.ts";
import type {TuvalConfigInput} from "../config.ts";
import {type AnyProgram, type Program, ProgramId} from "../registry/program.ts";

/** One generation of the fixture: the `claude` block, or the row's absence. */
export interface DeclaredClaudeConfig {
	readonly claude: ClaudeSessionConfigInput;
	readonly drop?: boolean;
}

export const CWD = "/repo";
export const AGENT_NODE = "agent";
export const OTHER_NODE = "other";
export const OTHER_PROGRAM = "other-session";

/** The four modes the `claude-session` row advertises, so any of them is an admissible `setMode`. */
const script: AgentScript = {
	sessionId: "session-7952",
	history: [],
	modes: {
		current: Mode.make("default"),
		available: ["default", "acceptEdits", "plan", "auto"].map((value) => Mode.make(value)),
	},
	models: {current: null, available: []},
	thinking: {current: null, available: []},
	interrupt: [],
	turns: [],
};

type State = {readonly seen: number};
type Msg = {readonly type: "tick"};
type Notify = {readonly type: "notify"};

/** A row with no `configChanged`: the reload walks past it whatever the config did. */
const other: AnyProgram = {
	id: ProgramId.make(OTHER_PROGRAM),
	core: defineMachine<State, Msg, Notify, never, unknown>({
		init: (loaded) => [loaded ?? {seen: 0}, []],
		update: {tick: (state) => [{seen: state.seen + 1}, []]},
		interpret: {notify: () => Promise.resolve()},
	}),
	ports: {},
	handlers: {notify: () => Effect.succeed([] as ReadonlyArray<Msg>)},
	capabilities: [],
	identity: {
		package: "@kampus/tuval",
		program: OTHER_PROGRAM,
		version: "1.0.0",
		digest: `sha256:${OTHER_PROGRAM}`,
	},
	placement: {host: "local"},
} satisfies Program<State, Msg, Notify, never, unknown, never, never>;

const declared = JSON.parse(
	readFileSync(process.env.TUVAL_CLAUDE_RELOAD_FIXTURE ?? "", "utf8"),
) as DeclaredClaudeConfig;

const claudeRow = claudeSession({
	cwd: CWD,
	claude: declared.claude,
	layer: ScriptedAiAgent.layer(script),
});

export default {
	version: 1,
	programs: declared.drop === true ? [other] : [claudeRow, other],
	graph: {
		nodes:
			declared.drop === true
				? [{id: OTHER_NODE, program: OTHER_PROGRAM, on: []}]
				: [
						{id: AGENT_NODE, program: CLAUDE_SESSION_PROGRAM, on: []},
						{id: OTHER_NODE, program: OTHER_PROGRAM, on: []},
					],
	},
} satisfies TuvalConfigInput;
