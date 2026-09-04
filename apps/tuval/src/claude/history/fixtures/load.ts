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
	| "error-result"
	| "init"
	| "interrupted-assistant"
	| "oversized-tool-turn"
	| "permission-denied"
	| "resumed-init"
	| "session-messages"
	| "tool-turn"
	| "unknown-message";

export const loadFixture = (name: FixtureName): unknown =>
	JSON.parse(readFileSync(join(import.meta.dirname, `${name}.json`), "utf8"));
