# Claude metadata fixture evidence

`native-2.1.217.jsonl` is a metadata-only projection of the existing
[native sidechain capture](../../../../../../apps/tuval/src/claude/history/fixtures/agent-a1b2c3d4e5f60718a.jsonl).
Its [capture record](../../../../../../apps/tuval/src/claude/history/fixtures/PROVENANCE.md#the-sidechain-capture)
dates the capture to 2026-09-07 and identifies Claude Code 2.1.217.

Projection performed on 2026-09-10. Only assistant rows remain, with `type`, `sessionId`,
`agentId`, `version`, `uuid`, `gitBranch` and the message's `id`, `role`, `model`, `usage`.
Content, prompts, tool inputs, paths and signatures were removed. Identity values were already
sanitized in the source capture. Tests rebind the session and agent IDs to their temporary tree.

The synthetic lifecycle envelopes follow the
[official hook reference](https://code.claude.com/docs/en/hooks), checked 2026-09-10.
Synthetic nested children, interruption and retry scenarios are test cases, not live captures.
The native `.meta.json` tool-call matching follows the same capture record's documented
`toolUseId` and `spawnDepth` fields. No new Claude execution was used to obtain this fixture.
