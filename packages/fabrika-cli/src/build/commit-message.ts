/**
 * The pure reads `build commit` makes over a commit message and over the path one may arrive on.
 *
 * The failure this module answers: a lane ran `git commit -F <path>` against a path that
 * held a **two-day-old message from another lane**. Nothing failed — the file existed, was
 * non-empty, and was a well-formed conventional-commit message — so the commit landed carrying a
 * subject about an issue the lane had never touched. That is the class property worth stating once:
 * every cheap check reads green, so the only things that can catch it are a read-back off the
 * created commit and a claim test over the numbers the message names.
 */

import {scanBody} from "../report/leaks.ts";

/** Every `#<n>` a message names, in order, duplicates included. */
export const issueRefsIn = (message: string): ReadonlyArray<number> =>
	[...message.matchAll(/#(\d+)\b/g)].flatMap((match) =>
		match[1] === undefined ? [] : [Number.parseInt(match[1], 10)],
	);

/** The subject's trailing `(#<n>)` — the shape the `build` skill's message convention writes. */
const TRAILING_REF = /\(#(\d+)\)\s*$/;

/**
 * A ref a closing or association keyword introduces, and the anchor is the whole guard: the keyword
 * must open its own line, so `does not close #<n>` is prose and `Closes #<n>` is a trailer.
 */
const TRAILER_REF = /^[ \t]*(?:closes?|closed|fix(?:e[sd])?|resolve[sd]?|part of)[ \t]+#(\d+)\b/gim;

/** The child number inside a merged ref — `build/<n>-…` direct, `replay/build-<n>-…-onto-<sha>`. */
const MERGED_BRANCH_REF = /(?:^|[/-])build[/-](\d+)-/g;

const QUOTED_REF = /'([^']*)'/g;

/**
 * Every `#<n>` a message claims to have *landed* — a strict subset of {@link issueRefsIn}.
 *
 * Three shapes are recognised, and each is one the pipeline actually writes onto an assembly branch:
 * a subject's trailing `(#<n>)`, a line-anchored `Closes`/`Fixes`/`Resolves`/`Part of` trailer, and
 * the ref inside the `Merge branch '<ref>' into <branch>` subject `lane integrate` produces. Nothing
 * else counts, so an incidental or negating mention names no landing — which is the whole point:
 * `issueRefsIn` matches a bare `#<n>` anywhere, and reading that as evidence let
 * `refactor(tracer): rework the helper; does not touch #<n>` discharge that number's dependency edge.
 *
 * It sits beside `issueRefsIn` rather than narrowing it, because `lane prove` and
 * {@link foreignRefsIn} want the loose read: prove asks whether a range mentions its child at all,
 * and the foreign-ref refusal must red on every number a message names, landing or not.
 */
export const landingRefsIn = (message: string): ReadonlyArray<number> => {
	const subject = subjectOf(message);
	const refs: number[] = [];
	const trailing = TRAILING_REF.exec(subject);
	if (trailing?.[1] !== undefined) refs.push(Number.parseInt(trailing[1], 10));
	for (const trailer of message.matchAll(TRAILER_REF))
		if (trailer[1] !== undefined) refs.push(Number.parseInt(trailer[1], 10));
	if (/^Merge branch(?:es)? /.test(subject))
		for (const quoted of subject.matchAll(QUOTED_REF))
			for (const merged of (quoted[1] ?? "").matchAll(MERGED_BRANCH_REF))
				if (merged[1] !== undefined) refs.push(Number.parseInt(merged[1], 10));
	return refs;
};

/** The numbers a message names that `permitted` does not hold — empty is the clean message. */
export const foreignRefsIn = (
	message: string,
	permitted: ReadonlySet<number>,
): ReadonlyArray<number> => [...new Set(issueRefsIn(message).filter((n) => !permitted.has(n)))];

/** A path's last segment. Never machine-local on its own, which is why a refusal may name it. */
export const leafOf = (path: string): string =>
	path
		.split("/")
		.filter((s) => s !== "")
		.at(-1) ?? "";

/**
 * Whether `path` is a leaf directly inside `dir` — the one shape a `--message-file` may take.
 *
 * **The test keys on the DIRECTORY and nothing else, and that is the contract, not an accident**
 * (§SP rule 2). Uniqueness lives in `build scratch`'s claim-nonce-keyed directory, so the leaf name
 * confers no safety and is never asked to: a run-keyed leaf in some other directory is refused
 * exactly like a plain one, and a plain `commit-message` leaf inside this lane's directory is
 * admitted. Keying the leaf instead is the anti-pattern the allocator was built to retire — a shared
 * directory with clever names is still a shared directory.
 *
 * Relative paths fail by construction: the allocator prints absolute paths, so anything that is not
 * one cannot have come from it.
 */
export const isLaneScratchLeaf = (path: string, dir: string): boolean => {
	const prefix = `${dir.replace(/\/+$/, "")}/`;
	if (!path.startsWith(prefix)) return false;
	const leaf = path.slice(prefix.length);
	return (
		leaf !== "" && leaf !== "." && leaf !== ".." && !leaf.includes("/") && !leaf.includes("\\")
	);
};

/**
 * A quoted foreign string with every machine-local path masked to its class root.
 *
 * Every refusal below quotes something this process did not write — git's own stderr, a message read
 * back off a commit — and git names the path it could not read (`fatal: could not read log file
 * '<path>'`). Quoting that verbatim would put a machine-local path in a refusal a caller pastes into
 * an issue, which is the leak `build pr` and `build note` already red on. Masking at the quote site
 * is what keeps the refusals free of one without keeping them silent.
 */
export const redact = (text: string): string => scanBody(text).redacted;

/** A quoted multi-line block for stderr: redacted, indented, so two of them read as two messages. */
export const quotedBlock = (text: string): ReadonlyArray<string> =>
	redact(text)
		.replace(/\n+$/, "")
		.split("\n")
		.map((line) => `    ${line}`);

/** A message's subject line — what a reader scanning a commit list actually sees. */
export const subjectOf = (message: string): string =>
	message
		.split("\n")
		.find((line) => line.trim() !== "")
		?.trim() ?? "";
