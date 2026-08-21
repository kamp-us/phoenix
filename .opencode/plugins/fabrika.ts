/**
 * opencode port of fabrika's `PreToolUse` spawn guard (`claude-plugins/fabrika/hooks.json`).
 *
 * Runs `fabrika hook spawn` over a synthesized harness envelope before every subagent spawn and
 * blocks the call when the verb answers deny. The envelope is synthesized because opencode has no
 * stdin-envelope hook protocol; the fields mirror what Claude Code sends so the same verb judges
 * both harnesses. A dispatch failure never denies — fail-open-and-loud is ruled in ADR 0250.
 */
import {spawnSync} from "node:child_process";
import {existsSync} from "node:fs";
import {join} from "node:path";
import type {Plugin} from "@opencode-ai/plugin";

interface MergedConfig {
	model?: string;
	agent?: Record<string, {model?: string}>;
}

const TASK_TOOLS = new Set(["task"]);

/**
 * opencode spells models `provider/model-id`; the verb's allowlist speaks the harness's bare ids
 * (`claude-opus-4-8`, alias `opus`). The provider prefix is adapter noise — strip it so an
 * opencode-configured Opus reaches the allowlist as itself and everything else stays denied.
 */
const toHarnessModel = (model: string): string => {
	const slash = model.lastIndexOf("/");
	return slash === -1 ? model : model.slice(slash + 1);
};

export const FabrikaPlugin: Plugin = async ({directory, worktree, client}) => {
	let config: MergedConfig | undefined;

	const root = worktree ?? directory;
	const bin = (() => {
		const local = join(root, "node_modules/.bin/fabrika");
		return existsSync(local) ? local : "fabrika";
	})();

	const judge = (model: string | null): {decision: "allow" | "deny"; reason?: string} => {
		const envelope = JSON.stringify({
			hook_event_name: "PreToolUse",
			session_id: "opencode",
			transcript_path: "",
			cwd: root,
			tool_input: model === null ? {} : {model: toHarnessModel(model)},
		});
		const run = spawnSync(bin, ["hook", "spawn"], {input: envelope, encoding: "utf8"});
		if (run.error || run.status !== 0) {
			return {
				decision: "allow",
				reason: `dispatch failed (status ${run.status}) — spawn proceeds unguarded`,
			};
		}
		let parsed: {
			hookSpecificOutput?: {permissionDecision?: string; permissionDecisionReason?: string};
		};
		try {
			parsed = JSON.parse(run.stdout);
		} catch {
			return {decision: "allow", reason: "unparseable verdict — spawn proceeds unguarded"};
		}
		const decision = parsed.hookSpecificOutput?.permissionDecision;
		if (decision === "deny")
			return {decision: "deny", reason: parsed.hookSpecificOutput?.permissionDecisionReason};
		if (decision === "allow") return {decision: "allow"};
		return {decision: "allow", reason: `unknown verdict ${decision} — spawn proceeds unguarded`};
	};

	return {
		config: (cfg) => {
			config = cfg as MergedConfig;
		},
		"tool.execute.before": async (input, output) => {
			if (!TASK_TOOLS.has(input.tool.toLowerCase())) return;

			const args = output.args as Record<string, unknown>;
			const target =
				typeof args.subagent_type === "string"
					? args.subagent_type
					: typeof args.agentType === "string"
						? args.agentType
						: typeof args.agent === "string"
							? args.agent
							: undefined;
			const requested = target
				? (config?.agent?.[target]?.model ?? config?.model ?? null)
				: (config?.model ?? null);

			const verdict = judge(requested);
			if (verdict.decision === "allow") {
				if (verdict.reason) {
					await client.app.log({
						body: {
							service: "fabrika",
							level: "warn",
							message: `${target ?? "spawn"}: ${verdict.reason}`,
						},
					});
				}
				return;
			}
			throw new Error(`fabrika hook spawn denied this subagent spawn: ${verdict.reason}`);
		},
	};
};
