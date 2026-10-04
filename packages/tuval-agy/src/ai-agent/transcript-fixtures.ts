/**
 * Captured agy `transcript.jsonl` lines, and the `transcript_full.jsonl` counterparts of the clipped
 * ones: single lines from the v1.1.27 census below, and a whole v1.1.28 multi-call turn read off
 * disk at the bottom of this file.
 *
 * Every line keeps the exact key set, value types and `source`/`type`/`status` vocabulary of the
 * files agy wrote under `$HOME/.gemini/antigravity-cli/brain/<cid>/.system_generated/logs/` — which
 * is what makes them evidence about a format that ships no schema and no version field. Two
 * substitutions, both so nothing machine-local lands in the repo: the invoking user's home reads
 * `/Users/founder`, and the long `content` values are cut to a readable length. The cut is why the
 * clipped pair below is a *constructed* pair rather than a captured one: the real full counterpart
 * of a clipped `content` runs to 8,605 characters.
 */

import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const CID = "9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf";

export const conversationId = CID;

/** The operator's turn. `USER_EXPLICIT`/`USER_INPUT` is the only combination that carries one. */
export const userInput =
	'{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-09-03T04:17:43Z","content":"<USER_REQUEST>\\nlist the files in this workspace\\n</USER_REQUEST>"}';

/** A tool call: `name` and `args` only, and `args` values are themselves JSON text on the wire. */
export const toolCall =
	'{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-09-03T04:17:43Z","tool_calls":[{"name":"list_dir","args":{"DirectoryPath":"\\"/Users/founder/agyprobe\\"","toolAction":"\\"List workspace files\\"","toolSummary":"\\"List workspace contents\\""}}]}';

/** The call's result, and it is the next line, not a field on the call. */
export const toolResult =
	'{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-09-03T04:17:49Z","content":"Created At: 2026-09-02T21:17:49-07:00\\nCompleted At: 2026-09-02T21:17:49-07:00\\n{\\"name\\":\\"README.md\\", \\"isDir\\":false}\\n{\\"name\\":\\"src\\", \\"isDir\\":true}"}';

/** A tool still in flight: agy writes the `GENERIC` line before the tool has finished. */
export const toolResultRunning =
	'{"step_index":2,"source":"MODEL","type":"GENERIC","status":"RUNNING","created_at":"2026-09-03T09:32:29Z","content":"Created At: 2026-09-03T02:32:29-07:00\\nTool is running as a background task with task id: task-86"}';

/**
 * The whole multi-call capture, read off disk rather than restated here.
 *
 * `fixtures/multi-call-transcript.jsonl` and its `_full` counterpart are the two files agy **v1.1.28**
 * wrote for one driven turn whose prompt forced two `view_file` calls into one planner step — the
 * capture #8689's ruling asked for, and the evidence that a batch's outcomes are per-call and in
 * order. They are the real files, not a reconstruction: the only edit is the workspace path, which
 * reads `/Users/founder/agyprobe` so nothing machine-local lands in the repo.
 *
 * Two things in them are worth knowing before reading a case over them. The outcome of the first
 * call sits at file position 1 while its own call line sits at position 2, so the file's order is
 * not the conversation's — `step_index` is. And the full file's `args` values are plain strings
 * where `transcript.jsonl`'s are JSON text, which is a second shape agy's two files disagree on and
 * a reason `restore` replaces only the fields `truncated_fields` names.
 */
const capture = (name: string): ReadonlyArray<string> =>
	readFileSync(fileURLToPath(import.meta.resolve(`./fixtures/${name}`)), "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0);

export const multiCallLines = capture("multi-call-transcript.jsonl");
export const multiCallFullLines = capture("multi-call-transcript_full.jsonl");

/** The conversation the capture above was driven as. Its own `step_index` values, not `CID`'s. */
export const multiCallConversationId = "c25acb51-24fc-45a1-a152-4859e934a53d";

/**
 * The same capture with its **first** outcome dropped — the leading-gap shape.
 *
 * Derived from the two files above by removing the `GENERIC` at `step_index` 2, which is the outcome
 * of the batch's *first* call, and nothing else: the two-call `PLANNER_RESPONSE` at step 1 and the
 * second call's outcome at step 3 are the real captured lines. It is what a batch agy answered out of
 * order looks like, and the shape run-position pairing read as "the run's first member is call 0's"
 * — handing call 0 the `two.txt` output it never asked for (#8912). The `_full` counterpart drops the
 * same line, because the two files align by position and carry the same `step_index` sequence.
 */
export const multiCallLeadingGapLines = capture("multi-call-leading-gap.jsonl");
export const multiCallLeadingGapFullLines = capture("multi-call-leading-gap_full.jsonl");

/** The reply. A `PLANNER_RESPONSE` carries `content`, `tool_calls`, or both. */
export const assistantReply =
	'{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-09-03T04:18:01Z","content":"The workspace holds a **README.md** and a **src/** directory."}';

/** The same reply, clipped: `truncated_fields` names the field whose whole value is elsewhere. */
export const assistantReplyClipped =
	'{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-09-03T04:18:01Z","content":"The workspace holds a **READ","truncated_fields":["content"]}';

/** Its `transcript_full.jsonl` counterpart: same `step_index`, whole value, nothing marked. */
export const assistantReplyFull = assistantReply;

/** `thinking` has no port field and is dropped rather than folded into the reply. */
export const assistantThinking =
	'{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-09-03T04:18:05Z","thinking":"The user asked for a listing; I already have it.","content":"Anything else?"}';

export const systemMessage =
	'{"step_index":5,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","created_at":"2026-09-03T09:34:32Z","content":"The following is a <SYSTEM_MESSAGE> not actually sent by the user."}';

/** A `SYSTEM` type absent from the epic's written spec, and present in the real file. */
export const checkpoint =
	'{"step_index":6,"source":"SYSTEM","type":"CHECKPOINT","status":"DONE","created_at":"2026-09-03T10:14:54Z","content":"{{ CHECKPOINT 0 }} The earlier parts of this conversation have been truncated."}';

/** Neither `source` nor `type` is a value this pin has seen. Nothing may be dropped for it. */
export const unrecognised =
	'{"step_index":7,"source":"ORACLE","type":"PROPHECY","status":"DONE","created_at":"2026-09-03T10:15:00Z","content":"a kind written by a newer agy"}';

/** What the tail of a live log looks like while agy is still writing to it. */
export const halfWritten = '{"step_index":8,"source":"MODEL","type":"PLANNER_RES';

/**
 * **Both sides of one conversation**, captured from agy **v1.2.0**: the NDJSON it streamed and the
 * log it wrote, for the same three turns. It is the only capture in this repo that holds the stream
 * and the log together, and that is what makes it evidence about the seam #8900 reported broken —
 * the window pages by sending a live row's own id back as a cursor, so the two sides' `step_index`
 * numbering *is* the join, and nothing but a paired capture can say what it is.
 *
 * The turns were driven the way the layer drives them (`launch.ts`'s `sessionArgv`): a first prompt
 * forcing two `view_file` calls into one planner step, a second running no tools, then the child was
 * stopped and a **third turn driven on a child that resumed the conversation** with
 * `--conversation=<id>` — which is the desk-restart shape, and why the resumed stream is its own
 * file. The numbering it measured, stream against log:
 *
 * | step | stream                      | log                                  |
 * | ---- | --------------------------- | ------------------------------------ |
 * | 0    | `user_input`, no delta      | `USER_INPUT` (ordinal 0)             |
 * | 1    | `agent_response`, no delta  | `PLANNER_RESPONSE`, 2 calls (ord. 2) |
 * | 2    | `tool` `view_file`          | `GENERIC`, first call's outcome (1)  |
 * | 3    | `tool` `view_file`          | `GENERIC`, second call's outcome (3) |
 * | 4    | `agent_response`, the reply | `PLANNER_RESPONSE`, content (ord. 4) |
 * | 5    | `user_input`, no delta      | `USER_INPUT` (ordinal 5)             |
 * | 6    | `agent_response`, the reply | `PLANNER_RESPONSE`, content (ord. 6) |
 * | 7    | `user_input`, no delta      | `USER_INPUT` (ordinal 7) — resumed   |
 * | 8    | `system_message`, no delta  | `SYSTEM`/`SYSTEM_MESSAGE` (ord. 8)   |
 * | 9    | `agent_response`, the reply | `PLANNER_RESPONSE`, content (ord. 9) |
 *
 * Three facts fall out of it. A tool row's live step is its *outcome* line's, never its call line's.
 * The log's file order is again not the conversation's (`step_index` 0,2,1,3,… over ordinals 0,1,2,3).
 * And `step_index` continues across the resume rather than restarting, so a restored child's ids land
 * in the same space as the ones the stopped child minted.
 *
 * The only edits are the two substitutions this file's head declares: the workspace reads
 * `/Users/founder/agyprobe` and the home `/Users/founder`, so nothing machine-local lands in the repo.
 */
export const liveJoinLines = capture("live-join-transcript.jsonl");
export const liveJoinFullLines = capture("live-join-transcript_full.jsonl");
export const liveJoinStreamLines = capture("live-join-stream.ndjson");

/** The third turn's stream, off a child that resumed the conversation the two files above hold. */
export const liveJoinResumedStreamLines = capture("live-join-resumed-stream.ndjson");

/** The conversation the paired capture above was driven as. */
export const liveJoinConversationId = "8377fd63-b158-49b9-b2c1-2d89ed9135ce";
