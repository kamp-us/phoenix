/**
 * Captured agy stream lines, verbatim apart from one substitution: the invoking user's home
 * directory reads `/Users/founder`, so no real home path lands in the repo. Everything down to
 * `resultSuccess` is v1.1.27, the version ADR 0362 pins; the usage census and the interrupted
 * `result` after it are v1.1.28, and the `error_message` pair at the foot is v1.2.0. Each says so
 * where it is declared, because a later-version capture is named as such rather than folded into the
 * pin (ADR 0362).
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

/**
 * A three-turn usage census, captured from **agy v1.1.28** on one conversation — the first two turns
 * on one child, the third on a child that resumed it with `--conversation=<id>`. It is here because
 * it is the only capture that can show what a one-turn capture cannot: `result.usage` is the
 * *conversation's* running total, while a turn's own `agent_response` step reports that turn's spend
 * (ADR 0362; [#8695](https://github.com/kamp-us/phoenix/issues/8695)).
 *
 * Read the six together: the steps report `16771/1`, `4648/1`, `4861/1` and the results report
 * `16771/1`, `21419/2`, `26280/3`.
 */
export const censusTurnOneStep =
	'{"event":"step_update","step_update":{"conversation_id":"cba39437-e61b-48f0-a7cd-d78b59b6fcae","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"ONE\\n","duration_seconds":1.418274,"usage":{"input_tokens":16771,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":16772}}}';

export const censusTurnOneResult =
	'{"event":"result","result":{"conversation_id":"cba39437-e61b-48f0-a7cd-d78b59b6fcae","status":"SUCCESS","response":"ONE\\n","duration_seconds":1.465859,"num_turns":1,"usage":{"input_tokens":16771,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":16772}}}';

export const censusTurnTwoStep =
	'{"event":"step_update","step_update":{"conversation_id":"cba39437-e61b-48f0-a7cd-d78b59b6fcae","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":1.277398,"usage":{"input_tokens":4648,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":12195,"total_tokens":4649}}}';

export const censusTurnTwoResult =
	'{"event":"result","result":{"conversation_id":"cba39437-e61b-48f0-a7cd-d78b59b6fcae","status":"SUCCESS","response":"TWO\\n","duration_seconds":2.783006,"num_turns":2,"usage":{"input_tokens":21419,"output_tokens":2,"thinking_tokens":0,"cache_read_tokens":12195,"total_tokens":21421}}}';

/** The resumed child's first turn. Its `step_index` continues at `6`, not at `0`. */
export const censusResumedStep =
	'{"event":"step_update","step_update":{"conversation_id":"cba39437-e61b-48f0-a7cd-d78b59b6fcae","step_index":6,"state":"DONE","step_type":"agent_response","text_delta":"\\n","duration_seconds":1.061844,"usage":{"input_tokens":4861,"output_tokens":1,"thinking_tokens":0,"cache_read_tokens":12188,"total_tokens":4862}}}';

export const censusResumedResult =
	'{"event":"result","result":{"conversation_id":"cba39437-e61b-48f0-a7cd-d78b59b6fcae","status":"SUCCESS","response":"THREE\\n","duration_seconds":31.583936,"num_turns":3,"usage":{"input_tokens":26280,"output_tokens":3,"thinking_tokens":0,"cache_read_tokens":24383,"total_tokens":26283}}}';

/**
 * The terminal `result` of a turn stopped with `SIGINT`, captured from a direct probe of agy v1.1.28.
 * The same shape the v1.1.27 desk run recorded on
 * [#8694](https://github.com/kamp-us/phoenix/issues/8694) — `status: "ERROR"`, an empty `response`
 * and `error: "interrupted"` — which is what corrected ADR 0362's reading of that string.
 */
export const resultInterrupted =
	'{"event":"result","result":{"conversation_id":"9cb073ff-0a81-4b21-b81b-1a2e1c78969c","status":"ERROR","response":"","error":"interrupted","duration_seconds":5.99386,"num_turns":1,"usage":{"input_tokens":16793,"output_tokens":1105,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":17898}}}';

/**
 * The `error_message` step and the terminal `result` of the turn it cut, both verbatim from **agy
 * v1.2.0** — a release past the `1.1.27` pin, named here rather than written back onto it (ADR 0362).
 * This is the step [#8896](https://github.com/kamp-us/phoenix/issues/8896) is about: before the
 * mapper had an arm for it, it reached the default arm and minted
 * `agy step 2 of an unrecognised type "error_message" (DONE)` into the operator's transcript.
 *
 * Captured on 2026-09-10 by driving the real binary — `agy --input-format=stream-json
 * --output-format=stream-json --print='' --model=gemini-3.8-flash-low --sandbox --add-dir=<scratch>` —
 * with a prompt asking for a verbatim passage of a copyrighted novel, which trips agy's own
 * recitation filter mid-reply. Eleven other drives (four `SIGINT` stops, six concurrent long
 * generations, a counting prompt) produced no `error_message` at all: the trigger is the filter, not
 * the stop, which is why "suppress it on the interrupt path" would have been the wrong fix.
 *
 * **Two readings the pair settles.** The step carries no `text_delta` — the field is absent, not
 * empty — so at this release there is no message on the live stream to render; and the message itself
 * rides the terminal `result.error`, on a `result` whose `status` is `ERROR` and whose `error` is not
 * `interrupted`, so the mapper's failure arm surfaces it. The turn *continued* after the step: the
 * long `response` below is the retry agy produced, which is why `num_turns` is still `1`.
 */
export const errorMessageStep =
	'{"event":"step_update","step_update":{"conversation_id":"65495e68-8a9c-47bd-956a-104b61cf1df7","step_index":2,"state":"DONE","step_type":"error_message","duration_seconds":0}}';

export const resultContentFiltered =
	'{"event":"result","result":{"conversation_id":"65495e68-8a9c-47bd-956a-104b61cf1df7","status":"ERROR","response":"I cannot reproduce the verbatim text of George Orwell\'s *1984*, as it remains under copyright protection in several jurisdictions, but I can provide a summary or discuss the themes, characters, and plot of the opening chapter.\\n\\n### Chapter 1 Summary\\n\\nIn the opening chapter of *1984*, Winston Smith returns to his dreary apartment building, Victory Mansions, amidst a harsh and gritty London setting in Oceania. The narrative immediately introduces the pervasive surveillance and psychological dominance of the totalitarian regime: telescreens broadcast continuous propaganda while monitoring residents\' every sound and movement, and ominous posters of Big Brother remind the populace that they are constantly watched. \\n\\nWinston navigates his cramped flat, positioning himself in an alcove hidden from the telescreen\'s direct view. There, he commits a forbidden act by opening a newly purchased blank diary and writing down his thoughts, an offense that carries severe penalties under the Thought Police. As he contemplates his discontent, he reflects on the state-mandated Two Minutes Hate, his conflicting emotions toward an enigmatic young woman from the Fiction Department, and his intuitive suspicion that an Inner Party official named O\'Brien might share his silent rebellion against the Party.\\n\\n***\\n\\nWould you like a summary or analysis of the next chapter, or an exploration of the themes and world-building introduced here?\\nI cannot reproduce the text of *1984* verbatim. However, I can provide a high-level summary and analysis of the opening chapter.\\n\\n### Overview of Chapter 1\\n\\nThe opening of the novel establishes the dystopian reality of Oceania and introduces the protagonist, Winston Smith. Living under the total control of the Party, citizens endure constant surveillance via two-way telescreens, pervasive propaganda, and the looming presence of the Thought Police. \\n\\nDisillusioned and seeking an outlet for his private thoughts, Winston retreats to a rare blind spot in his flat to commit a forbidden act of defiance: beginning a personal journal. Through his reflections, the chapter outlines key elements of the totalitarian regime—such as the institutionalized hysteria of the Two Minutes Hate—and introduces figures who provoke Winston\'s suspicion, fear, and cautious curiosity.\\n\\n***\\n\\nWould you like a summary of the next chapter, or would you prefer an analysis of the novel\'s major themes and motifs?\\n","error":"Your previous response was blocked by content safety filters: The generated content was filtered because it may contain material that resembles existing copyrighted works. Try rephrasing the prompt. If you think this was an error, [send feedback](https://ai.google.dev/gemini-api/docs/troubleshooting).\\nPlease provide a response that complies with content policies, or briefly explain to the user why you cannot help with this request\\nRetries remaining: 3","duration_seconds":5.591085,"num_turns":1,"usage":{"input_tokens":22341,"output_tokens":468,"thinking_tokens":0,"cache_read_tokens":11722,"total_tokens":22809}}}';
