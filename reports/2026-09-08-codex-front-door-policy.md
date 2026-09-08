# Codex front-door invocation proof

Issue: [#8618](https://github.com/kamp-us/phoenix/issues/8618).
Runtime: Codex CLI `0.153.4`. Date: 2026-09-08.

## Result

The shared skill remains human-only in the Fabrika roster and in Claude's frontmatter.
Its adjacent `agents/openai.yaml` adds Codex's explicit-only policy. The real Codex runtime
omits the skill from an ordinary prompt and includes its complete body when the prompt explicitly
names `$fabrika:front-door`.

| Request | Discovery control advertised | front-door advertised | front-door body loaded |
|---|---|---|---|
| `Say hello.` | yes | no | no |
| `$fabrika:front-door` | yes | yes | yes |

The control is an ordinary skill in the same installed plugin. Its presence distinguishes policy
exclusion from a plugin that failed to load altogether. The test compares the request Codex constructs,
before any model responds; it makes no claim about a model's subsequent decisions.

## Reproduce

With Codex CLI on `PATH` and workspace dependencies installed, run from the repository root:

```bash
pnpm --filter @kampus/fabrika-cli exec vitest run src/status/front-door-policy.unit.test.ts src/status/status.cli.test.ts
FABRIKA_CODEX_PROOF=1 pnpm --filter @kampus/fabrika-cli exec vitest run src/status/front-door-codex.cli.test.ts
```

The first command passed four checks, including the real `status open --field menu` command's
exit status and readout shape. The second passed the real Codex policy proof. Its
[test source](../packages/fabrika-cli/src/status/front-door-codex.cli.test.ts) creates a temporary
marketplace, installs the shared front-door skill and a discovery control in an isolated Codex
profile, and starts two requests against a loopback provider. The provider captures request construction
and returns no model output; the test then terminates each child. No API credentials, hosted model
calls, GitHub writes or production pipeline execution are involved.

The Codex proof is opt-in because Codex CLI is an external prerequisite, not a workspace dependency.
An ordinary test run skips it; a skipped proof is not runtime evidence. The unit policy check runs
in the normal suite.

## Validator discrepancy

The supplied plugin-creator validator rejects the retained Claude field with:

```text
skill `front-door` frontmatter field `disable-model-invocation` must be false
```

The supplied skill-creator quick validator also rejects that field as outside its allowed keys.
These are validator failures, not passes. Neither validator was modified or bypassed. The runtime
proof establishes the narrower fact that Codex accepts this shared skill and honors its Codex
invocation policy. Removing the Claude field would change the other harness's behavior merely to
satisfy a packaging check.

## Sources and limits

[OpenAI's optional skill metadata](https://learn.chatgpt.com/docs/build-skills#optional-metadata)
documents `policy.allow_implicit_invocation: false` and continued explicit invocation. The test above
checks that behavior in the installed runtime instead of inferring it from successful installation.

The skill now runs `fabrika status open` as an explicit tool step. It relies on no inline shell
interpolation. The existing unreadable-source terminal handles a failed command or missing readout;
the output-as-data boundary and per-field unknown states remain in force. This proof does not run
the full operating conversation or establish Codex lane orchestration compatibility.
