/**
 * Captured agy v1.1.27 stream lines, verbatim apart from one substitution: the invoking user's
 * home directory reads `/Users/founder`, so no real home path lands in the repo.
 *
 * Every line below came off a live run of
 * `agy --input-format=stream-json --output-format=stream-json --print='' --model=gemini-3.8-flash-low
 * --sandbox --add-dir=<dir>` — which is what makes them evidence rather than a guess about a wire
 * that ships no schema and no version field.
 */

/** `init`, with `--model` given. `model` is absent when the run took the CLI's default. */
export const init =
	'{"event":"init","conversation_id":"9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf","init":{"model":"gemini-3.8-flash-low","cwd":"/tmp/agyprobe","tools":["ask_custom_permission","ask_permission","ask_question","browser_click_element","browser_drag_pixel_to_pixel","browser_get_dom","browser_get_network_request","browser_input","browser_list_network_requests","browser_mouse_down","browser_mouse_up","browser_move_mouse","browser_press_key","browser_refresh_page","browser_resize_window","browser_scroll","browser_scroll_dom","browser_select_option","browser_subagent","call_mcp_tool","capture_browser_console_logs","capture_browser_screenshot","click_browser_pixel","command_status","define_subagent","delete_knowledge","execute_browser_javascript","find_by_name","finish","generate_image","grep_search","invoke_subagent","list_browser_pages","list_dir","list_permissions","list_resources","manage_inbox","manage_subagents","manage_task","multi_replace_file_content","notebook_edit","notebook_execution","open_browser_url","read_browser_page","read_resource","read_url_content","replace_file_content","run_command","schedule","search_web","sed_file","send_command_input","send_message","view_file","wait","wait_5_seconds","write_to_file"],"permission_mode":"request-review"}}';

/** The `user_input` step. v1.1.27 puts no text on it — the prompt is not echoed back. */
export const userInput =
	'{"event":"step_update","step_update":{"conversation_id":"9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf","step_index":0,"state":"DONE","step_type":"user_input"}}';

/** The turn's first reply chunk. */
export const responseActive =
	'{"event":"step_update","step_update":{"conversation_id":"9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"The current directory contains **5** files:\\n\\n- [err.txt](file:///tmp/agyprobe/err.txt)\\n- [out.ndjson](file:///tmp/agyprobe/out.ndjson)\\n- [sample.txt](file:///t"}}';

/** The last chunk, and it is a chunk: `"mp/agyprobe/sample.txt)…"` continues the line above rather than repeating it. */
export const responseDone =
	'{"event":"step_update","step_update":{"conversation_id":"9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"mp/agyprobe/sample.txt)\\n- [tool.err](file:///tmp/agyprobe/tool.err)\\n- [tool.ndjson](file:///tmp/agyprobe/tool.ndjson)\\n\\nTotal count: **5**\\n","duration_seconds":3.425466,"usage":{"input_tokens":4481,"output_tokens":110,"thinking_tokens":0,"cache_read_tokens":12195,"total_tokens":4591}}}';

/** A tool call, before its outcome: `tool_info` carries `parameters` and no `output`. */
export const toolActive =
	'{"event":"step_update","step_update":{"conversation_id":"9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"list_dir","tool_info":{"name":"list_dir","parameters":{"DirectoryPath":"/tmp/agyprobe"}}}}';

/** The same `step_index`, now with `tool_info.output`. */
export const toolDone =
	'{"event":"step_update","step_update":{"conversation_id":"9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf","step_index":2,"state":"DONE","step_type":"tool","tool_name":"list_dir","duration_seconds":0.03474,"tool_info":{"name":"list_dir","parameters":{"DirectoryPath":"/tmp/agyprobe"},"output":"err.txt\\nout.ndjson\\nsample.txt\\ntool.err\\ntool.ndjson"}}}';

/** The other outcome: `tool_info.error {type, message}`, from a `view_file` on a missing path. */
export const toolError =
	'{"event":"step_update","step_update":{"conversation_id":"efa24031-a6f7-483e-81af-1fad5fae1887","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"view_file","duration_seconds":0.033857,"tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/agyprobe/definitely-missing.txt"},"error":{"type":"TOOL_ERROR","message":"declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: invalid tool call error (invalid_args) failed to read file: open /tmp/agyprobe/definitely-missing.txt: no such file or directory"}}}}';

/** An `invoke_subagent` call. `subagent_info.subagents[]` is the whole payload. */
export const subagentActive =
	'{"event":"step_update","step_update":{"conversation_id":"e9e99659-bc69-44f8-8b42-3dea5c1a5008","step_index":2,"state":"ACTIVE","step_type":"subagent","tool_name":"invoke_subagent","subagent_info":{"subagents":[{"type_name":"research","role":"Robotics Historian","initial_prompt":"Please briefly answer: What are the three laws of robotics introduced by Isaac Asimov? Keep the answer concise.","conversation_id":"4ce4cca7-2b7f-4728-b171-1a84d3ff70f6","log_uri":"file:///Users/founder/.gemini/antigravity-cli/brain/4ce4cca7-2b7f-4728-b171-1a84d3ff70f6/.system_generated/logs/transcript.jsonl","workspace_uris":["file:///tmp/agyprobe2"]}]}}}';

/** The same step, done — the `subagent_info` payload is identical and carries no result. */
export const subagentDone =
	'{"event":"step_update","step_update":{"conversation_id":"e9e99659-bc69-44f8-8b42-3dea5c1a5008","step_index":2,"state":"DONE","step_type":"subagent","tool_name":"invoke_subagent","duration_seconds":0.237139,"subagent_info":{"subagents":[{"type_name":"research","role":"Robotics Historian","initial_prompt":"Please briefly answer: What are the three laws of robotics introduced by Isaac Asimov? Keep the answer concise.","conversation_id":"4ce4cca7-2b7f-4728-b171-1a84d3ff70f6","log_uri":"file:///Users/founder/.gemini/antigravity-cli/brain/4ce4cca7-2b7f-4728-b171-1a84d3ff70f6/.system_generated/logs/transcript.jsonl","workspace_uris":["file:///tmp/agyprobe2"]}]}}}';

/** A `system_message` step, and it carries no text at all. */
export const systemMessage =
	'{"event":"step_update","step_update":{"conversation_id":"e9e99659-bc69-44f8-8b42-3dea5c1a5008","step_index":4,"state":"DONE","step_type":"system_message","duration_seconds":0.000191}}';

/** The terminal `result`. `response` holds text no step delta carried (`"I have delegated…"`). */
export const resultSuccess =
	'{"event":"result","result":{"conversation_id":"9dcbb5a5-9a5f-4f9c-989b-ede03e790bbf","status":"SUCCESS","response":"The current directory contains **5** files:\\n\\n- [err.txt](file:///tmp/agyprobe/err.txt)\\n- [out.ndjson](file:///tmp/agyprobe/out.ndjson)\\n- [sample.txt](file:///tmp/agyprobe/sample.txt)\\n- [tool.err](file:///tmp/agyprobe/tool.err)\\n- [tool.ndjson](file:///tmp/agyprobe/tool.ndjson)\\n\\nTotal count: **5**\\n","duration_seconds":4.7196169999999995,"num_turns":1,"usage":{"input_tokens":20963,"output_tokens":151,"thinking_tokens":0,"cache_read_tokens":12195,"total_tokens":21114}}}';
