# Claude metadata fixture evidence

`native-2.1.217.jsonl` is a metadata-only projection of an existing native sidechain capture.
The source Git blob is `a41241efc7e9d3474e7de9a2e4161f188c698435`; its capture record is
blob `928debc3db2164d05aa8b0bec662c30c7d09073d`, section "The sidechain capture".
Both are retained by commit `b679fae44721aeb81ba092674c7025f57c8026a9` and readable with
`git show <blob>`. The record dates the capture to 2026-09-07 and identifies Claude Code 2.1.217.

Projection performed on 2026-09-10. Only assistant rows remain, with `type`, `sessionId`,
`agentId`, `version`, `uuid`, `gitBranch` and the message's `id`, `role`, `model`, `usage`.
Content, prompts, tool inputs, paths and signatures were removed. Identity values were already
sanitized in the source capture. Tests rebind the session and agent IDs to their temporary tree.

The synthetic lifecycle envelopes follow the
[official hook reference](https://code.claude.com/docs/en/hooks), checked 2026-09-10.
Synthetic nested children, interruption and retry scenarios are test cases, not live captures.
The native `.meta.json` tool-call matching follows the same capture record's documented
`toolUseId` and `spawnDepth` fields. No new Claude execution was used to obtain this fixture.

`subagent-stop.payload.golden.json` copies the existing live-captured JSON from the
[hook reference](../../../../../../claude-plugins/fabrika/docs/hook-surface.md#subagentstop--identifies-the-subagent-states-no-outcome),
which identifies Claude Code 2.1.233 and the stdin probe method. Paths and opaque parent
identities were already elided in that record; no fields were added or removed here.
The collector's golden tests also use the existing
[SessionStart capture](../../../hook/__fixtures__/session-start.payload.golden.json)
and its [capture record](../../../hook/__fixtures__/PROVENANCE.md).
Tests rebind only filesystem paths to temporary files, preserve captured key sets, and supply
synthetic response metadata. These tests exercise captured hook inputs without running Claude.
