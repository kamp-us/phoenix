import {readdirSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import type {Config, Plugin} from "@opencode-ai/plugin";
import {parseAgentMarkdown} from "./agents.ts";
import {raiseSubagentDepth} from "./subagent-depth.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agentsDir = resolve(here, "./agents");
const skillsDir = resolve(here, "./skills");

// The runtime config schema carries `skills.paths` and `subagent_depth` (opencode core v1
// config; this repo's own opencode.json sets both), but @opencode-ai/sdk@1.18.21's generated
// Config type declares neither — so the keys this plugin writes go through these narrow views.
type SkillsConfigView = {paths?: string[]};
type DepthConfigView = {subagent_depth?: number};

type AgentEntry = NonNullable<NonNullable<Config["agent"]>[string]>;

export const FabrikaOpenCodePlugin: Plugin = async () => {
	return {
		config: async (cfg) => {
			cfg.agent = cfg.agent ?? {};
			for (const entry of readdirSync(agentsDir).sort()) {
				if (!entry.endsWith(".md")) continue;
				const shell = parseAgentMarkdown(readFileSync(join(agentsDir, entry), "utf8"));
				const def: AgentEntry = {mode: shell.mode ?? "subagent", prompt: shell.prompt};
				if (shell.description !== undefined) def.description = shell.description;
				if (shell.permission !== undefined) {
					def.permission = shell.permission as NonNullable<AgentEntry["permission"]>;
				}
				cfg.agent[shell.name] = def;
			}

			const skills = (cfg as Config & {skills?: SkillsConfigView}).skills ?? {};
			skills.paths = [...(skills.paths ?? [])];
			if (!skills.paths.includes(skillsDir)) {
				skills.paths.push(skillsDir);
			}
			(cfg as Config & {skills?: SkillsConfigView}).skills = skills;

			const depth = cfg as Config & DepthConfigView;
			depth.subagent_depth = raiseSubagentDepth(depth.subagent_depth);
		},
	};
};

export default FabrikaOpenCodePlugin;
