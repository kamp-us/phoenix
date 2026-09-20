# Attributed usage fixture evidence

These are synthetic, metadata-only envelopes derived from native counter shapes. They are not
captured prompts or claims of automatic host integration. Identity and model values are test data.

| Fixture | Source contract and tested shape |
|---|---|
| [codex.json](./codex.json) | Codex CLI 0.154.0 `token_usage_record`, with fields grounded against [`TokenUsageRecord`, `TokenUsage` and `non_cached_input`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs), inspected 2026-09-10 |
| [claude.json](./claude.json) | Messages API `2023-06-01` usage and TTL fields from [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), sections "Understanding the token breakdown" and "Tracking cache performance", inspected 2026-09-10 |

Codex input includes its cached-input subset. Its cache-write field is absent in this fixture and
keeps unknown arithmetic meaning; no input relationship is invented. Reasoning is an output detail
in the [Responses usage schema](https://github.com/openai/openai-node/blob/master/src/resources/responses/responses.ts),
`ResponseUsage.OutputTokensDetails`. The cumulative test uses the same raw counters under a
different basis, so its snapshot cannot be added as another response.
The native `thread_id`, `session_id` and `root_turn_id` stay separate in the common envelope.

Claude's three input components are separate. The 5-minute and 1-hour fields are subsets of
`cache_creation_input_tokens`. The source documentation's 8/5120/0/0 usage example supplies this
fixture's counts. Neither fixture supplies cached output, and neither reader creates it.

The common recorder is tested against these envelopes. Native parsing, supported host-version
detection, automatic callbacks and descendant discovery remain host-adapter responsibilities.
