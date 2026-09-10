import {Layer} from "effect";
import type {AiAgentSessionMsg} from "../ai-agent/core/index.ts";
import {Mode} from "../ai-agent/ports/index.ts";
import {type AiAgentProgram, aiAgentProgram} from "../ai-agent/program.ts";
import {AI_AGENT_INSPECTOR_REF} from "../ai-agent/renderer-ref.ts";
import type {TuvalAiAgent} from "../ai-agent/service/index.ts";
import {KernelBridge} from "../ai-agent/tools/KernelBridge.ts";
import type {SpellBridge} from "../commands/bridge/index.ts";
import type {Scope as SpellScope} from "../commands/spell.ts";
import type {AnyProgram} from "../registry/program.ts";
import {CodexAiAgent} from "./CodexAiAgent.ts";
import {
	type CodexSessionConfigInput,
	type CodexSessionSettings,
	codexSessionSettings,
} from "./config.ts";
import {CODEX_CHAT_WINDOW_REF, CODEX_SESSION_PROGRAM} from "./renderer-ref.ts";

export {CODEX_SESSION_PROGRAM} from "./renderer-ref.ts";

interface CodexSessionBase {
	readonly cwd: string;
	readonly codex?: CodexSessionConfigInput;
	readonly itemLimit?: number;
	readonly byteLimit?: number;
}
export type CodexSessionProgramOptions = CodexSessionBase &
	(
		| {readonly scope: SpellScope; readonly layer?: undefined}
		| {readonly layer: Layer.Layer<TuvalAiAgent>; readonly scope?: undefined}
	);
export interface CodexSessionProgram extends AiAgentProgram<SpellBridge> {
	readonly settings: CodexSessionSettings;
}
const isCodexSession = (row: AnyProgram): row is CodexSessionProgram =>
	row.id === CODEX_SESSION_PROGRAM && "settings" in row;

export const codexSession = (options: CodexSessionProgramOptions): CodexSessionProgram => {
	const settings = codexSessionSettings(options.codex ?? {});
	return {
		...aiAgentProgram<SpellBridge>({
			id: CODEX_SESSION_PROGRAM,
			layer:
				options.layer ??
				CodexAiAgent.layer(settings).pipe(Layer.provide(KernelBridge.live(options.scope))),
			config: {
				cwd: options.cwd,
				...(options.itemLimit === undefined ? {} : {itemLimit: options.itemLimit}),
				...(options.byteLimit === undefined ? {} : {byteLimit: options.byteLimit}),
			},
			renderer: CODEX_CHAT_WINDOW_REF,
			inspector: AI_AGENT_INSPECTOR_REF,
			capabilities: [
				{
					family: "process-control",
					detail: "spawns, sends to and reads other processes through the three kernel tools",
				},
			],
		}),
		settings,
		configChanged: (next): ReadonlyArray<AiAgentSessionMsg> =>
			isCodexSession(next) && next.settings.mode !== settings.mode
				? [{type: "setMode", mode: Mode.make(next.settings.mode)}]
				: [],
	};
};
