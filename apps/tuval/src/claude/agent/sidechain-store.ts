/**
 * Where a subagent's transcript lives on disk, and the read that gets it.
 *
 * `getSessionMessages` cannot serve this. At `@anthropic-ai/claude-agent-sdk@0.3.259` it takes a
 * session id and "returns Array of messages, or empty array if session not found" (`sdk.d.ts`) —
 * and its implementation opens on a UUID guard that answers `[]` outright (`sdk.mjs`). A
 * subagent's agent id is not a UUID and its rows are not at the session path, so the call answers
 * the empty array twice over: an undifferentiated empty, not a refusal. The SDK's own
 * `getSubagentMessages` is declined for the same reason, and it is the whole reason — every
 * failure path in its implementation answers `[]` too (a missing directory, an unreadable file and
 * an absent agent all return the empty array), so a caller cannot tell a subagent that said
 * nothing from a read that never happened.
 *
 * Keeping those apart is the point of this read, so the file is opened here and each failure comes
 * back as its own refusal. A subagent is not resumable as a session of its own either, which is
 * the other half of #8384's Q6: it is read off its own file and driven through its parent.
 */

import {homedir} from "node:os";
import {Effect, FileSystem, Path} from "effect";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {
	isSidechainRefusal,
	readSidechain,
	SUBAGENTS_DIR,
	sidechainFileName,
	sidechainMetaName,
} from "../history/index.ts";
import {subagentMalformed, subagentNotFound, subagentStoreUnreadable} from "./refusals.ts";

/** The session this read is about: the working directory it ran in, and its id. */
export interface SidechainSession {
	readonly cwd: string;
	readonly id: string;
}

export interface SubagentTranscript {
	readonly items: ReadonlyArray<TranscriptItem>;
	/** The subagent's type off its meta file, or the unnamed fallback. */
	readonly type: string;
}

/**
 * The CLI's project store. `CLAUDE_CONFIG_DIR` is the documented relocation and `~/.claude` is the
 * default; `node:os`'s `homedir` has no platform-service equivalent, so it arrives as a parameter
 * default exactly as `.patterns/effect-platform-access.md` rules.
 */
export const claudeProjectsDir = (
	path: Path.Path,
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string => path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "projects");

/**
 * The project directory name the CLI derives from a working directory: every non-alphanumeric
 * character replaced with `-` (`sdk.mjs` at 0.3.259). It is a candidate and not an answer — the
 * CLI resolves symlinks first, truncates past 200 characters with a hash of its own, and honours a
 * name override — so a miss falls through to the scan rather than failing.
 */
export const projectSlug = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** The session's own directory under the project store, found by name or by scanning for it. */
const locateSessionDir = Effect.fn("Claude.locateSessionDir")(function* (
	session: SidechainSession,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const projects = claudeProjectsDir(path);
	const at = (slug: string) => path.join(projects, slug, session.id);
	const unreadable = Effect.mapError(subagentStoreUnreadable);

	const candidate = at(projectSlug(session.cwd));
	if (yield* fs.exists(candidate).pipe(unreadable)) return candidate;
	for (const entry of yield* fs.readDirectory(projects).pipe(unreadable)) {
		if (yield* fs.exists(at(entry)).pipe(unreadable)) return at(entry);
	}
	return yield* subagentNotFound(session.id, "no stored session directory for this session");
});

/**
 * One subagent's settled transcript and its type.
 *
 * The meta file is read for the type alone and never fails the read: a subagent whose label could
 * not be found is still a subagent whose rows the operator asked for.
 */
export const readSubagentTranscript = Effect.fn("Claude.readSubagentTranscript")(function* (
	session: SidechainSession,
	agentId: string,
	at: number,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const unreadable = Effect.mapError(subagentStoreUnreadable);
	const dir = path.join(yield* locateSessionDir(session), SUBAGENTS_DIR);

	const file = path.join(dir, sidechainFileName(agentId));
	if (!(yield* fs.exists(file).pipe(unreadable))) {
		return yield* subagentNotFound(agentId, "no transcript file for this subagent");
	}
	const jsonl = yield* fs.readFileString(file).pipe(unreadable);
	const meta = yield* fs
		.readFileString(path.join(dir, sidechainMetaName(agentId)))
		.pipe(Effect.orElseSucceed(() => null));

	const read = readSidechain({jsonl, meta}, {at});
	if (isSidechainRefusal(read)) return yield* subagentMalformed(agentId, read.line, read.detail);
	const transcript: SubagentTranscript = {items: read.items, type: read.type};
	return transcript;
});
