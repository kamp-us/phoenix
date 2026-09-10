import {id, json, object} from "./codex-records.ts";

export const codexIssue = (event: Record<string, unknown>): number | null => {
	const input = object(event.tool_input);
	const command = id(input.cmd) ?? id(input.command);
	const invocation = command?.match(
		/^\s*(?:node\s+[^\s;|&]*\bbin\.(?:ts|js)|fabrika)\s+([a-z-]+)\s+([a-z-]+)\s*(.*)$/s,
	);
	if (!invocation) return null;
	const [, group, verb, args] = invocation;
	let value: string | undefined;
	if (event.hook_event_name === "PreToolUse") {
		const explicit = args?.match(/(?:^|\s)--issue\s+([1-9]\d*)\b/);
		if (group === "build" && explicit) value = explicit[1];
		else if (
			(group === "build" && ["claim", "issue", "resume-child"].includes(verb ?? "")) ||
			(group === "triage" && ["claim", "enrich", "apply", "park"].includes(verb ?? "")) ||
			(group === "review" && verb === "criteria")
		)
			value = args?.match(/^([1-9]\d*)\b/)?.[1];
		else if (group === "grill" && verb === "open")
			value = args?.match(/(?:^|\s)--ticket\s+([1-9]\d*)\b/)?.[1];
	}
	if (
		event.hook_event_name === "PostToolUse" &&
		(group === "review" || group === "ship") &&
		verb === "scope"
	) {
		const response = object(event.tool_response);
		if (response.exit_code !== undefined && response.exit_code !== 0) return null;
		const output = id(response.output) ?? id(response.stdout) ?? id(event.tool_response);
		const scoped = object(json(output ?? ""));
		const issue = object(scoped.issue);
		if (scoped.outcome === "scoped" && typeof issue.number === "number")
			value = String(issue.number);
		else value = output?.match(/^scoped\t[^\n]*\t(?:fixes|part-of):([1-9]\d*)\s*$/m)?.[1];
	}
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
};
