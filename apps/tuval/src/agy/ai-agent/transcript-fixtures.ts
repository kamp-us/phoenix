/**
 * Captured agy v1.1.27 `transcript.jsonl` lines, and the `transcript_full.jsonl` counterparts of the
 * clipped ones.
 *
 * Every line keeps the exact key set, value types and `source`/`type`/`status` vocabulary of the
 * files agy wrote under `$HOME/.gemini/antigravity-cli/brain/<cid>/.system_generated/logs/` — which
 * is what makes them evidence about a format that ships no schema and no version field. Two
 * substitutions, both so nothing machine-local lands in the repo: the invoking user's home reads
 * `/Users/founder`, and the long `content` values are cut to a readable length. The cut is why the
 * clipped pair below is a *constructed* pair rather than a captured one: the real full counterpart
 * of a clipped `content` runs to 8,605 characters.
 */

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
 * Two calls on one `PLANNER_RESPONSE`, and constructed rather than captured: the census found the
 * shape but no multi-call line survived the cut described above. It keeps the captured call line's
 * exact key set and `args`-as-JSON-text shape, so what it tests is the reader's handling of
 * `tool_calls.length > 1` and makes no claim about agy's wire the captured lines do not already make.
 */
export const toolCallBatch =
	'{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-09-03T04:17:43Z","tool_calls":[{"name":"list_dir","args":{"DirectoryPath":"\\"/Users/founder/agyprobe\\""}},{"name":"read_file","args":{"AbsolutePath":"\\"/Users/founder/agyprobe/README.md\\""}}]}';

/** The batch's one outcome line: agy writes a single `GENERIC` for both calls above, not one each. */
export const toolResultBatch =
	'{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-09-03T04:17:49Z","content":"Created At: 2026-09-02T21:17:49-07:00\\nCompleted At: 2026-09-02T21:17:49-07:00\\nthe batch finished"}';

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
