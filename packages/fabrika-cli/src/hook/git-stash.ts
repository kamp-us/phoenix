/**
 * Whether a Bash command runs `git stash`, and whether the checkout it runs in shares its stash.
 *
 * IO-free: the caller runs `git rev-parse` and hands the outcome in, so every arm is a unit test.
 *
 * `refs/stash` lives in the common git dir, so in a linked worktree `git stash` pushes to and pops
 * from the one stack every worktree of the clone shares — and a pop can restore a sibling lane's
 * files and drop its entry, with no warning either way. Scoping the command (`git -C "$WT" stash`)
 * does not help, which is why the refusal keys on the subcommand and not on where it is addressed.
 *
 * The command reader finds every simple command on the line, including those inside `$( )`,
 * backticks, subshells, `sh -c '…'` and `eval`, and reads through `VAR=value` prefixes and the
 * wrapper words listed below. It is not a shell parser: a here-document body is data, and a word
 * whose meaning is run-time (an alias, a function, a variable holding `git`) is not resolved.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/6844#issuecomment-5519865462
 */
import {isAbsolute} from "node:path";
import type {ChildOutcome} from "../io/exec.ts";
import type {Decision} from "./pre-tool-use.ts";

type Words = ReadonlyArray<string>;

/** Characters that end a simple command when no quote holds them. */
const COMMAND_ENDS = new Set([";", "&", "|", "(", ")", "\n"]);

/** Where a word ends that is not whitespace or a command end. */
const WORD_ENDS = new Set([" ", "\t", "<", ">"]);

/** The index of the `)` closing a `$(` or `(` whose body starts at `from`, quotes respected. */
const closingParen = (text: string, from: number): number => {
	let depth = 1;
	for (let at = from; at < text.length; at += 1) {
		const char = text[at] as string;
		if (char === "\\") {
			at += 1;
		} else if (char === "'") {
			const close = text.indexOf("'", at + 1);
			at = close === -1 ? text.length : close;
		} else if (char === '"') {
			for (at += 1; at < text.length && text[at] !== '"'; at += 1) {
				if (text[at] === "\\") at += 1;
			}
		} else if (char === "(") {
			depth += 1;
		} else if (char === ")") {
			depth -= 1;
			if (depth === 0) return at;
		}
	}
	return text.length;
};

const closingBacktick = (text: string, from: number): number => {
	for (let at = from; at < text.length; at += 1) {
		if (text[at] === "\\") at += 1;
		else if (text[at] === "`") return at;
	}
	return text.length;
};

/**
 * Every simple command in `text`, as its words with quoting removed, in the order they appear —
 * a command substitution's commands before the command that holds it.
 */
export const simpleCommands = (text: string): ReadonlyArray<Words> => {
	const found: Array<Words> = [];
	let words: Array<string> = [];
	let word = "";
	let inWord = false;
	let redirectTarget = false;
	const heredocs: Array<{readonly delimiter: string; readonly stripTabs: boolean}> = [];
	let at = 0;

	const endWord = () => {
		if (!inWord) return;
		if (redirectTarget) redirectTarget = false;
		else words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = () => {
		endWord();
		redirectTarget = false;
		if (words.length > 0) found.push(words);
		words = [];
	};
	const substitute = (body: string, placeholder: string) => {
		found.push(...simpleCommands(body));
		word += placeholder;
		inWord = true;
	};
	const readDoubleQuoted = () => {
		inWord = true;
		for (; at < text.length; at += 1) {
			const char = text[at] as string;
			if (char === '"') {
				at += 1;
				return;
			}
			if (char === "\\" && '$`"\\\n'.includes(text[at + 1] ?? "")) {
				at += 1;
				word += text[at];
			} else if (char === "$" && text[at + 1] === "(") {
				const close = closingParen(text, at + 2);
				substitute(text.slice(at + 2, close), "$(…)");
				at = close;
			} else if (char === "`") {
				const close = closingBacktick(text, at + 1);
				substitute(text.slice(at + 1, close), "`…`");
				at = close;
			} else {
				word += char;
			}
		}
	};
	const readHeredocOperator = () => {
		endWord();
		at += 2;
		const stripTabs = text[at] === "-";
		if (stripTabs) at += 1;
		while (text[at] === " " || text[at] === "\t") at += 1;
		let delimiter = "";
		while (at < text.length && !/[\s;&|()<>]/.test(text[at] as string)) {
			const char = text[at] as string;
			if (char !== "'" && char !== '"' && char !== "\\") delimiter += char;
			at += 1;
		}
		heredocs.push({delimiter, stripTabs});
	};
	const skipHeredocBodies = () => {
		for (const {delimiter, stripTabs} of heredocs) {
			while (at < text.length) {
				const end = text.indexOf("\n", at) === -1 ? text.length : text.indexOf("\n", at);
				const line = text.slice(at, end);
				at = end + 1;
				if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
			}
		}
		heredocs.length = 0;
	};

	while (at < text.length) {
		const char = text[at] as string;
		if (char === "\\") {
			if (text[at + 1] !== "\n") {
				word += text[at + 1] ?? "";
				inWord = true;
			}
			at += 2;
		} else if (char === "'") {
			const close = text.indexOf("'", at + 1);
			const end = close === -1 ? text.length : close;
			word += text.slice(at + 1, end);
			inWord = true;
			at = end + 1;
		} else if (char === '"') {
			at += 1;
			readDoubleQuoted();
		} else if (char === "$" && text[at + 1] === "(") {
			const close = closingParen(text, at + 2);
			substitute(text.slice(at + 2, close), "$(…)");
			at = close + 1;
		} else if (char === "`") {
			const close = closingBacktick(text, at + 1);
			substitute(text.slice(at + 1, close), "`…`");
			at = close + 1;
		} else if (char === "#" && !inWord) {
			const end = text.indexOf("\n", at);
			at = end === -1 ? text.length : end;
		} else if (char === "<" && text[at + 1] === "<" && text[at + 2] !== "<") {
			readHeredocOperator();
		} else if (char === "\n") {
			endCommand();
			at += 1;
			skipHeredocBodies();
		} else if (COMMAND_ENDS.has(char)) {
			endCommand();
			at += 1;
		} else if (char === "<" || char === ">") {
			// A digit run just before the operator is its fd (`2>`), not a word of the command.
			if (inWord && /^\d+$/.test(word)) {
				word = "";
				inWord = false;
			}
			endWord();
			while (at < text.length && "<>&|".includes(text[at] as string)) at += 1;
			redirectTarget = true;
		} else if (WORD_ENDS.has(char)) {
			endWord();
			at += 1;
		} else {
			word += char;
			inWord = true;
			at += 1;
		}
	}
	endCommand();
	return found;
};

/** A `NAME=` prefix, which sets a variable for one command without being a command itself. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Words that run the command after them rather than being it. */
const PASS_THROUGH = new Set([
	"!",
	"{",
	"}",
	"if",
	"then",
	"else",
	"elif",
	"while",
	"until",
	"do",
	"command",
	"exec",
	"nohup",
	"time",
]);

/** Wrappers that take options before the command, and which of those options take a value. */
const OPTION_WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
	env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
	sudo: new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t", "-D"]),
	nice: new Set(["-n"]),
};

/** `git` global options that take their value as the next word. */
const GIT_VALUED_OPTIONS = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--config-env",
	"--super-prefix",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

const basename = (word: string): string => word.slice(word.lastIndexOf("/") + 1);

/** Where the command proper starts once prefixes and wrappers are read past. */
const commandStart = (words: Words): number => {
	let at = 0;
	while (at < words.length) {
		const word = words[at] as string;
		if (PASS_THROUGH.has(word) || ASSIGNMENT.test(word)) {
			at += 1;
			continue;
		}
		const valued = OPTION_WRAPPERS[basename(word)];
		if (valued === undefined) return at;
		at += 1;
		while (at < words.length) {
			const option = words[at] as string;
			if (valued.has(option)) at += 2;
			else if (option.startsWith("-") || ASSIGNMENT.test(option)) at += 1;
			else break;
		}
	}
	return at;
};

/** Whether `words`, read from `start`, are `git [global options] stash …`. */
const isGitStash = (words: Words, start: number): boolean => {
	if (basename(words[start] ?? "") !== "git") return false;
	let at = start + 1;
	while (at < words.length && (words[at] as string).startsWith("-")) {
		at += GIT_VALUED_OPTIONS.has(words[at] as string) ? 2 : 1;
	}
	return words[at] === "stash";
};

/** The script a `sh -c '…'` or `eval …` runs, which is itself a command line to read. */
const nestedScript = (words: Words, start: number): string | undefined => {
	const program = basename(words[start] ?? "");
	if (program === "eval") return words.slice(start + 1).join(" ");
	if (!SHELLS.has(program)) return undefined;
	const flag = words.findIndex(
		(word, index) => index > start && /^-[A-Za-z]*c[A-Za-z]*$/.test(word),
	);
	return flag === -1 ? undefined : words[flag + 1];
};

export type StashRead =
	| {readonly _tag: "None"}
	/** `invocation` is the simple command that runs it, words space-joined, for the refusal text. */
	| {readonly _tag: "Stash"; readonly invocation: string};

/** Whether any simple command on this line is a `git stash`, in any subcommand form. */
export const findGitStash = (command: string): StashRead => {
	for (const words of simpleCommands(command)) {
		const start = commandStart(words);
		if (isGitStash(words, start)) return {_tag: "Stash", invocation: words.join(" ")};
		const script = nestedScript(words, start);
		if (script !== undefined) {
			const nested = findGitStash(script);
			if (nested._tag === "Stash") return nested;
		}
	}
	return {_tag: "None"};
};

/** The argv the caller runs in the envelope's `cwd`; absolute output is what makes the pair comparable. */
export const GIT_DIRS_ARGS = [
	"rev-parse",
	"--path-format=absolute",
	"--git-dir",
	"--git-common-dir",
] as const;

export interface GitDirs {
	readonly gitDir: string;
	readonly commonDir: string;
}

export type GitDirsRead =
	| {readonly _tag: "Read"; readonly dirs: GitDirs}
	/** Nothing was established, so nothing may be judged. */
	| {readonly _tag: "Unread"; readonly reason: string};

const decoded = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Read the two dirs off a {@link GIT_DIRS_ARGS} run. Anything but two absolute paths is Unread. */
export const readGitDirs = (outcome: ChildOutcome, timeoutSeconds: number): GitDirsRead => {
	if (outcome._tag === "Unstartable") {
		return {_tag: "Unread", reason: `could not run git — ${outcome.reason}`};
	}
	if (outcome.timedOut) {
		return {_tag: "Unread", reason: `git rev-parse did not finish within ${timeoutSeconds}s`};
	}
	if (outcome.exitCode !== 0) {
		const first = decoded(outcome.stderr).trim().split("\n")[0] ?? "";
		return {
			_tag: "Unread",
			reason: first === "" ? `git rev-parse exited ${outcome.exitCode}` : first,
		};
	}
	const lines = decoded(outcome.stdout)
		.split("\n")
		.filter((line) => line.trim() !== "");
	const [gitDir, commonDir] = lines;
	if (lines.length !== 2 || gitDir === undefined || commonDir === undefined) {
		return {_tag: "Unread", reason: `git rev-parse printed ${lines.length} line(s), not 2`};
	}
	if (!isAbsolute(gitDir) || !isAbsolute(commonDir)) {
		return {_tag: "Unread", reason: "git rev-parse printed a relative path"};
	}
	return {_tag: "Read", dirs: {gitDir, commonDir}};
};

export const PATTERN_DOC = ".patterns/worktree-agent-constraints.md";

/**
 * Judge a `git stash` against the checkout it runs in.
 *
 * One git dir means this checkout owns the stack alone, so the stash is its own business. Two means a
 * linked worktree, whose stack every sibling worktree also pushes to and pops from.
 */
export const decideStash = (invocation: string, {gitDir, commonDir}: GitDirs): Decision =>
	gitDir === commonDir
		? {
				_tag: "Allow",
				because: `${gitDir} is the only git dir here, so the stash stack is not shared`,
			}
		: {
				_tag: "Deny",
				reason: `fabrika refuses \`${invocation}\` in a linked worktree: refs/stash lives in the common git dir ${commonDir}, not in this worktree's ${gitDir}, so every worktree of the clone shares one stash stack. A sibling lane's entry can become stash@{0} between your push and your pop, and the pop then restores their files into your tree and drops their entry, with no warning. Scoping it with \`git -C\` does not help. To set work aside, commit it to your branch and reset back to it later. See ${PATTERN_DOC}.`,
			};
