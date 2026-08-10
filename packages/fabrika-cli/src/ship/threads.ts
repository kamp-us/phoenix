/**
 * The thread facts `ship threads` prints and `ship resolve` re-derives before it writes.
 *
 * **Class is a whitelist computed over the whole thread, not its first comment.** v1 classed by the
 * opening comment alone, so a human's "no, this matters" reply on a bot thread stayed bot-resolvable
 * — here one human participant makes the thread `human`. Everything not positively `Bot` is `human`
 * **by construction, never by enumeration**: no login-suffix inference, no allowlist of known bots,
 * so a Mannequin, an Organization, a ghost author and an absent field all land on the safe side.
 *
 * `human` unlocks nothing. Only a positive `bot` reaches the skill's nit judgment.
 */
import type {ReviewThread} from "./github.ts";

export type ThreadClass = "bot" | "human";

/** GraphQL's own type name for an app-authored comment — the one token that unlocks anything. */
const BOT = "Bot";

export const classOfThread = (thread: ReviewThread): ThreadClass =>
	thread.comments.length > 0 && thread.comments.every((comment) => comment.authorType === BOT)
		? "bot"
		: "human";

/** The first non-`Bot` participant, which the `16` refusal names so the caller can route it. */
export const firstHumanOf = (
	thread: ReviewThread,
): {readonly login: string; readonly typename: string} | null => {
	const found = thread.comments.find((comment) => comment.authorType !== BOT);
	return found === undefined
		? null
		: {login: found.author, typename: found.authorType || "unknown"};
};

export const siteOf = (thread: ReviewThread): string =>
	thread.path === null ? "pr-level" : `${thread.path}:${thread.line ?? "?"}`;

export const openingAuthorOf = (thread: ReviewThread): string => thread.comments[0]?.author ?? "";

/** The first 160 bytes of the opening comment, newlines flattened so one thread is one line. */
export const excerptOf = (thread: ReviewThread): string =>
	(thread.comments[0]?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
