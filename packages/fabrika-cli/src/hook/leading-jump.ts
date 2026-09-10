/**
 * The leading directory jump — reading one off a command string, and deciding whether it escapes the
 * working tree the command was issued in.
 *
 * IO-free on purpose: the caller does the git probes and hands this module three absolute paths, so
 * every refusal below is a unit test rather than a worktree fixture.
 *
 * **Why this decision exists at all.** Claude Code's own isolation guard reads the *command text*:
 * `git -C <other-checkout>`, `--git-dir=`, `GIT_DIR=` and `cd <other-checkout> && git …` are each
 * refused by name. A program that reaches git in a child process carries no matchable `git` token,
 * so `cd <shared> && node …/bin.ts build branch <n>` runs, exits 0, and leaves the shared checkout
 * standing on the lane branch — observed twice in the field. The jump is the one half of that shape
 * that is statically decidable from the command string alone, which is why the refusal is keyed on
 * it and not on what follows.
 *
 * The keyword set is `cd` and `pushd` because the ruling names the act — a leading directory jump —
 * rather than one spelling of it. It is not a shell parser and must not become one: anything it
 * cannot resolve to a literal path is refused rather than guessed at, which is the same polarity the
 * harness takes when it answers *too complex to verify that it stays inside the worktree*.
 */
import {isAbsolute, resolve, sep} from "node:path";

/** The two spellings of the act the ruling names. A jump is a jump whichever one is typed. */
export const JUMP_KEYWORDS = ["cd", "pushd"] as const;

export type Jump =
	/** The command does not open with a directory jump. Nothing here to judge. */
	| {readonly _tag: "None"}
	/** A jump whose destination is written out, and so can be resolved without running anything. */
	| {readonly _tag: "Literal"; readonly keyword: string; readonly target: string}
	/** A jump whose destination only exists once the shell has run. Where it lands is unknowable. */
	| {
			readonly _tag: "Unverifiable";
			readonly keyword: string;
			readonly argument: string;
			readonly reason: string;
	  };

/** Where an unquoted separator ends the first command of the line. */
const SEPARATORS = new Set([";", "&", "|", "\n"]);

/** The first command's text, up to the first separator no quote is holding open. */
const firstCommand = (text: string): string => {
	let quote: string | undefined;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index] as string;
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (SEPARATORS.has(char)) return text.slice(0, index);
	}
	return text;
};

/** Split on whitespace no quote is holding open, keeping each token's quoting with it. */
const operands = (text: string): ReadonlyArray<string> => {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of text) {
		if (quote !== undefined) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current !== "") tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current !== "") tokens.push(current);
	return tokens;
};

const wrappedIn = (token: string, quote: string): boolean =>
	token.length >= 2 && token.startsWith(quote) && token.endsWith(quote);

/**
 * Read the leading jump off a command string.
 *
 * A single-quoted operand cannot expand, so it is literal whatever it contains; anything else
 * carrying a `$`, a backtick or a glob resolves at run time and is refused rather than resolved.
 * A bare `cd` is a jump to `$HOME` and is read as exactly that — not as an absent one.
 */
export const parseLeadingJump = (command: string): Jump => {
	const head = firstCommand(command.trimStart());
	const keyword = JUMP_KEYWORDS.find(
		(word) => head === word || head.startsWith(`${word} `) || head.startsWith(`${word}\t`),
	);
	if (keyword === undefined) return {_tag: "None"};

	const tokens = operands(head.slice(keyword.length));
	if (tokens.length === 0) return {_tag: "Literal", keyword, target: "~"};
	if (tokens.length > 1) {
		return {
			_tag: "Unverifiable",
			keyword,
			argument: tokens.join(" "),
			reason: "it carries more than one operand",
		};
	}

	const token = tokens[0] as string;
	if (wrappedIn(token, "'")) return {_tag: "Literal", keyword, target: token.slice(1, -1)};

	const bare = wrappedIn(token, '"') ? token.slice(1, -1) : token;
	if (bare === "-") {
		return {
			_tag: "Unverifiable",
			keyword,
			argument: token,
			reason: "it names the previous directory, which only the shell knows",
		};
	}
	if (/[$`]/.test(bare)) {
		return {_tag: "Unverifiable", keyword, argument: token, reason: "it expands at run time"};
	}
	if (/[*?[]/.test(bare)) {
		return {_tag: "Unverifiable", keyword, argument: token, reason: "it is a glob"};
	}
	return {_tag: "Literal", keyword, target: bare};
};

export type Decision =
	| {readonly _tag: "Allow"; readonly because: string}
	| {readonly _tag: "Deny"; readonly reason: string};

export interface JumpGround {
	readonly command: string;
	/** The directory the harness says the command runs in. */
	readonly cwd: string;
	/** The linked worktree this command is isolated in — absolute, real-path resolved. */
	readonly workingTree: string;
	/** `$HOME`, for a `~` or a bare jump. Absent means a `~` target cannot be resolved. */
	readonly home: string | undefined;
}

/** Whether one absolute path is the tree itself or sits under it. */
const inside = (tree: string, target: string): boolean => {
	const root = tree.endsWith(sep) ? tree.slice(0, -1) : tree;
	return target === root || target.startsWith(`${root}${sep}`);
};

const expandHome = (target: string, home: string): string =>
	target === "~" ? home : `${home}${target.slice(1)}`;

/**
 * Judge one command against the tree it was issued in.
 *
 * Three arms, and the middle one is the point: a jump that lands inside the isolated tree is
 * ordinary work, a jump that lands outside it is the escape, and a jump nobody can resolve is
 * refused rather than read as either. The refusal text names an absolute path instead, because a
 * jump is never the only way to reach one — which keeps the guard from closing a route that has no
 * replacement.
 */
export const decideJump = ({command, cwd, workingTree, home}: JumpGround): Decision => {
	const jump = parseLeadingJump(command);
	if (jump._tag === "None")
		return {_tag: "Allow", because: "the command opens with no directory jump"};

	const advice = `Work from ${workingTree}, addressing anything outside it by absolute path.`;
	if (jump._tag === "Unverifiable") {
		return {
			_tag: "Deny",
			reason: `fabrika refuses this \`${jump.keyword}\`: ${jump.reason}, so whether it leaves the isolated worktree cannot be decided before it runs. ${advice}`,
		};
	}

	if (jump.target.startsWith("~") && home === undefined) {
		return {
			_tag: "Deny",
			reason: `fabrika refuses this \`${jump.keyword} ${jump.target}\`: HOME is unset, so the target cannot be resolved. ${advice}`,
		};
	}

	const expanded = jump.target.startsWith("~")
		? expandHome(jump.target, home as string)
		: jump.target;
	const target = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
	if (inside(workingTree, target)) {
		return {_tag: "Allow", because: `the jump stays inside ${workingTree}`};
	}
	return {
		_tag: "Deny",
		reason: `fabrika refuses this \`${jump.keyword} ${jump.target}\`: it leaves the isolated worktree ${workingTree} for ${target}, and whatever follows then runs there — including a program that reaches git in a child process, which carries no \`git\` token for the harness to match and has moved a shared checkout's HEAD in the field. ${advice}`,
	};
};
