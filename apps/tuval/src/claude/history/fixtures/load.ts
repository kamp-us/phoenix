/**
 * The golden fixtures, loaded verbatim off disk (`.patterns/golden-real-payload-fixtures.md`).
 *
 * Read rather than imported so no bundler or type checker can quietly reshape them: what the test
 * asserts against must be the captured bytes. See `PROVENANCE.md` beside this file for how the
 * capture was taken and what was sanitized.
 */

import {readFileSync} from "node:fs";
import {join} from "node:path";

export type FixtureName =
	| "assistant-turn"
	| "compact-boundary"
	| "error-result"
	| "informational-notice"
	| "init"
	| "interrupted-assistant"
	| "local-command-caveat-turn"
	| "local-command-lines-turn"
	| "local-command-turn"
	| "oversized-tool-turn"
	| "permission-denied"
	| "resumed-init"
	| "session-messages"
	| "streaming-turn"
	| "subagent-turn"
	| "thinking-turn"
	| "tool-turn"
	| "two-subagent-turn"
	| "unknown-message";

export const loadFixture = (name: FixtureName): unknown =>
	JSON.parse(readFileSync(join(import.meta.dirname, `${name}.json`), "utf8"));

/** The captured subagent's id, which is also what names both of its files. */
export const SIDECHAIN_AGENT_ID = "a1b2c3d4e5f60718a";

/**
 * The sidechain capture, as text. Not `loadFixture`'s shape: a `.jsonl` is not one JSON document,
 * and the reader under test is the thing that decides what its lines are.
 */
export const loadSidechain = (): {readonly jsonl: string; readonly meta: string} => ({
	jsonl: readFileSync(join(import.meta.dirname, `agent-${SIDECHAIN_AGENT_ID}.jsonl`), "utf8"),
	meta: readFileSync(join(import.meta.dirname, `agent-${SIDECHAIN_AGENT_ID}.meta.json`), "utf8"),
});
