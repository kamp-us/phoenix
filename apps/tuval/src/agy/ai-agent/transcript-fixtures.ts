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
