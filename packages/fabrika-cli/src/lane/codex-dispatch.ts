import type {LaneShell} from "../wire/lane-brief.ts";
import type {LogEntry} from "./fold.ts";
import {bareEvent} from "./machine.ts";

export const CODEX_ROLE_SKILLS: Readonly<Record<LaneShell, ReadonlyArray<string>>> = {
	builder: ["build"],
	"ui-builder": ["build", "build-ui"],
	reviewer: ["review"],
	"ui-reviewer": ["review-ui"],
	shipper: ["ship"],
};

export const codexPrompt = (skills: ReadonlyArray<string>, brief: string): string =>
	`Follow the Fabrika stage skills below. Read every named SKILL.md and its required references before acting. Resolve supporting files relative to the skill directory. Work only in this process's dedicated worktree. Use the lane brief's Fabrika entrypoint for every verb. Record your terminal through lane report as the skill requires. Do not run another pipeline stage.\n\n${skills.map((skill) => `Skill: ${JSON.stringify(skill)}`).join("\n")}\n\n${brief}`;

export const reportedTerminal = (
	before: ReadonlyArray<LogEntry>,
	after: ReadonlyArray<LogEntry>,
	task: string,
): LogEntry | null => {
	if (before.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(after[index]))) {
		return null;
	}
	const added = after.slice(before.length).filter((entry) => entry.task === task);
	if (added.length !== 1) return null;
	const entry = added[0];
	return entry !== undefined &&
		["DONE", "PASS", "FAIL", "BLOCKED", "WIP"].includes(bareEvent(entry.event))
		? entry
		: null;
};
