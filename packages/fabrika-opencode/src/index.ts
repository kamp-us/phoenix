import {readdirSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import type {Config, Plugin} from "@opencode-ai/plugin";
import {parseAgentMarkdown} from "./agents.ts";

const here = dirname(fileURLToPath(import.meta.url));
const agentsDir = resolve(here, "./agents");
const skillsDir = resolve(here, "./skills");

// The runtime config schema carries `skills.paths` (opencode core v1 config; this repo's
// own opencode.json sets it), but @opencode-ai/sdk@1.18.21's generated Config type does
// not declare it yet — so the one key this plugin appends goes through this narrow view.
type SkillsConfigView = {paths?: string[]};

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
		},
	};
};

export default FabrikaOpenCodePlugin;
