import {parse} from "yaml";

export type AgentDefinition = {
	name: string;
	description?: string;
	mode?: "subagent" | "primary" | "all";
	permission?: PermissionRuleset;
	prompt: string;
};

const ACTIONS = ["ask", "allow", "deny"] as const;
export type PermissionAction = (typeof ACTIONS)[number];

// opencode's v1 agent permission ruleset: top-level tool keys mapping to an action or
// (bash-style) a pattern map of actions.
export type PermissionRuleset = {
	[tool: string]: PermissionAction | {[pattern: string]: PermissionAction};
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MODES = ["subagent", "primary", "all"] as const;

export const parseAgentMarkdown = (source: string): AgentDefinition => {
	const match = FRONTMATTER.exec(source);
	if (!match) {
		throw new Error("agent shell markdown carries no --- frontmatter block");
	}

	const frontmatter = match[1];
	if (frontmatter === undefined) {
		throw new Error("agent shell markdown carries an empty --- frontmatter block");
	}

	const prompt = source.slice(match[0].length).trim();
	if (prompt.length === 0) {
		throw new Error("agent shell markdown carries an empty prompt body");
	}

	const data: unknown = parse(frontmatter);
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error("agent shell frontmatter is not a mapping");
	}
	const fields = data as Record<string, unknown>;
	if (typeof fields.name !== "string" || fields.name.length === 0) {
		throw new Error("agent shell frontmatter carries no name");
	}
	const mode = MODES.find((candidate) => candidate === fields.mode);
	if (fields.mode !== undefined && mode === undefined) {
		throw new Error(
			`agent shell ${fields.name} declares mode ${JSON.stringify(fields.mode)}, not a mode literal`,
		);
	}

	const shell: AgentDefinition = {name: fields.name, prompt};
	if (typeof fields.description === "string") shell.description = fields.description;
	if (mode !== undefined) shell.mode = mode;
	if (fields.permission !== undefined)
		shell.permission = parsePermissionRuleset(fields.permission, fields.name);
	return shell;
};

// Authored shells ship only shapes this returns — anything else throws so a bad mirror
// dies at build time and test, never silently at install.
export const parsePermissionRuleset = (value: unknown, shell: string): PermissionRuleset => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`agent shell ${shell} declares permission that is not a mapping`);
	}
	const out: PermissionRuleset = {};
	for (const [tool, rule] of Object.entries(value)) {
		const action = ACTIONS.find((candidate) => candidate === rule);
		if (action !== undefined) {
			out[tool] = action;
			continue;
		}
		if (typeof rule === "object" && rule !== null && !Array.isArray(rule)) {
			const patterns: {[pattern: string]: PermissionAction} = {};
			for (const [pattern, inner] of Object.entries(rule)) {
				const innerAction = ACTIONS.find((candidate) => candidate === inner);
				if (innerAction === undefined) {
					throw new Error(
						`agent shell ${shell} declares permission ${tool}[${pattern}] = ${JSON.stringify(inner)}, not an action literal`,
					);
				}
				patterns[pattern] = innerAction;
			}
			out[tool] = patterns;
			continue;
		}
		throw new Error(
			`agent shell ${shell} declares permission ${tool} that is neither an action nor a pattern map`,
		);
	}
	return out;
};
