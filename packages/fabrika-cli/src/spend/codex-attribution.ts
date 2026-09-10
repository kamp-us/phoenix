import {id, json, object} from "./codex-records.ts";

const commands = (text: string): string[][] | null => {
	const result: string[][] = [];
	let words: string[] = [],
		word = "",
		quote = "",
		started = false;
	const flush = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	for (let i = 0; i < text.length; i++) {
		const char = text.charAt(i);
		if (char === "\\" && quote !== "'") {
			const next = text[++i];
			if (next === undefined) return null;
			if (next !== "\n") {
				word += next;
				started = true;
			}
		} else if (char === quote) quote = "";
		else if (!quote && (char === "'" || char === '"')) {
			quote = char;
			started = true;
		} else if (quote === "'") word += char;
		else if (char === "$" || char === "`" || (!quote && /[<>()]/.test(char))) return null;
		else if (!quote && char === "#" && !started) {
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
		} else if (!quote && /[;|&\n]/.test(char)) {
			flush();
			if (words.length) result.push(words);
			words = [];
		} else if (!quote && /\s/.test(char)) flush();
		else {
			word += char;
			started = true;
		}
	}
	if (quote) return null;
	flush();
	if (words.length) result.push(words);
	return result;
};

const invocationIssue = (event: Record<string, unknown>, words: string[]): number | null => {
	const [group, verb, ...args] = words;
	const flags = new Map<string, string>();
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) break;
		if (arg === "--") {
			positional.push(...args.slice(i + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const equal = arg.indexOf("=");
		if (equal !== -1) flags.set(arg.slice(0, equal), arg.slice(equal + 1));
		else if (!["--json", "--resume", "--confirm", "--require-clean"].includes(arg))
			flags.set(arg, args[++i] ?? "");
	}
	let value: string | undefined;
	if (event.hook_event_name === "PreToolUse") {
		if (group === "build" && flags.has("--issue")) value = flags.get("--issue");
		else if (
			(group === "build" && ["claim", "issue", "resume-child"].includes(verb ?? "")) ||
			(group === "triage" && ["claim", "enrich", "apply", "park"].includes(verb ?? "")) ||
			(group === "review" && verb === "criteria")
		)
			value = positional[0];
		else if (group === "grill" && verb === "open") value = flags.get("--ticket");
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

export type CodexAttribution =
	| {readonly kind: "issue"; readonly issue: number}
	| {readonly kind: "none" | "continuation" | "unresolved"};

export const codexAttribution = (event: Record<string, unknown>): CodexAttribution => {
	if (!["PreToolUse", "PostToolUse"].includes(String(event.hook_event_name))) return {kind: "none"};
	const input = object(event.tool_input);
	const command = id(input.cmd) ?? id(input.command);
	const parsed = commands(command ?? "");
	if (!parsed) return {kind: /\bfabrika\b/.test(command ?? "") ? "unresolved" : "none"};
	const issues = new Set<number>();
	let detected = false;
	for (const words of parsed) {
		const offset =
			words[0] === "fabrika"
				? 1
				: words[0] === "node" && /(?:^|\/)bin\.(?:ts|js)$/.test(words[1] ?? "")
					? 2
					: 0;
		if (!offset) continue;
		detected = true;
		const issue = invocationIssue(event, words.slice(offset));
		if (issue !== null) issues.add(issue);
		else if (
			(event.hook_event_name === "PreToolUse" &&
				/^(?:build (?:claim|issue|resume-child)|triage (?:claim|enrich|apply|park)|review criteria|grill open)$/.test(
					words.slice(offset, offset + 2).join(" "),
				)) ||
			/^(?:review|ship) scope$/.test(words.slice(offset, offset + 2).join(" "))
		)
			return {kind: "unresolved"};
	}
	if (issues.size > 1) return {kind: "unresolved"};
	const issue = issues.values().next().value;
	return issue !== undefined ? {kind: "issue", issue} : {kind: detected ? "continuation" : "none"};
};

export const codexIssue = (event: Record<string, unknown>): number | null => {
	const association = codexAttribution(event);
	return association.kind === "issue" ? association.issue : null;
};
