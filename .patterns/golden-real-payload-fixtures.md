# Golden real-payload fixtures for hook/harness handlers

**Law:** [ADR 0180](../.decisions/0180-capture-real-runtime-artifact-before-coding.md) —
for anything the runtime *emits* (a Claude Code hook payload, a platform event schema, any
contract observable only at execution) the **captured real artifact is the only ground
truth**, and a handler's test against its committed golden fixture is a **blocking** gate.
This doc is the how; the ADR is the why. Read the ADR first.

## The failure this prevents

[#2925](https://github.com/kamp-us/phoenix/pull/2925) shipped the `WorktreeCreate` hook
built to an *inferred* payload — it read `worktree_path` + `base_ref`, neither of which the
harness sends. The real payload is `{ session_id, transcript_path, cwd, prompt_id,
agent_type, hook_event_name, name }`: it carries `cwd` + `name` and expects the path
**constructed** as `<cwd>/.claude/worktrees/<name>`. The unit test passed because it
asserted the *fabricated* shape, so review-code + CI + control-plane approval all went green
on a hook that fail-closed on every spawn crew-wide. No gate executes the real harness, so
none could catch "the documented contract is wrong." A captured real payload is what makes
the spec real.

## The pattern

1. **Capture the real artifact first (harness step, out of repo).** Observing the payload
   needs a live spawn against the harness the founder owns (the #2440-class boundary). Capture
   the actual JSON the runtime emits — not a doc summary, not a plausible-looking shape.
2. **Commit it as a golden fixture.** Co-locate next to the handler's test under
   `__fixtures__/<handler>.payload.golden.json` (e.g.
   [`packages/fabrika-cli/src/hook/__fixtures__/pre-tool-use-spawn.payload.golden.json`](../packages/fabrika-cli/src/hook/__fixtures__/pre-tool-use-spawn.payload.golden.json)).
   The **key set + construction rule is the golden part**; opaque per-spawn values
   (`session_id`/`transcript_path`/`prompt_id`, and the absolute `cwd`) are sanitized to
   representative placeholders — never a real operator path or PII
   ([no-local-paths convention](../CLAUDE.md)). What must stay real is the *shape*: which
   keys exist, and which do NOT (here: a spawn's `tool_name` is `Agent` even though the
   matcher that fired is `Task`, and `model` arrives as the harness alias `opus` — the two
   facts a hand-authored envelope gets wrong). Record how the capture was taken beside the
   fixtures: [`PROVENANCE.md`](../packages/fabrika-cli/src/hook/__fixtures__/PROVENANCE.md)
   is what lets a reviewer tell a captured payload from an invented one.
3. **Load it verbatim, never inline the payload.** The raw fixture bytes are the assertion
   path's input, via the shared loader
   [`packages/fabrika-cli/src/golden-fixture.ts`](../packages/fabrika-cli/src/golden-fixture.ts):
   `readGoldenFixture(import.meta.url, "__fixtures__/…json")` for the raw stdin bytes,
   `loadGoldenPayload(…)` for a parsed record to assert the shape. A hand-authored payload in
   the assertion path is the anti-pattern — it re-admits the fabrication #2925 shipped.
4. **Assert the handler against the fixture, and assert the shape.** Drive the real handler
   (feed the golden payload on stdin and assert what the handler emits — see
   [`packages/fabrika-cli/src/hook/envelope.golden.test.ts`](../packages/fabrika-cli/src/hook/envelope.golden.test.ts)
   for the direct form and `pretooluse-polarity.cli.test.ts` for the CLI-driven one),
   plus a direct shape assertion (`assert.notProperty(p, "worktree_path")`) so the captured
   contract's *absences* are guarded too. The litmus: **the test must FAIL against the old
   fabricated contract** — if it passes against both shapes it isn't guarding the real one.
   Only environment-specific values a fixed fixture cannot pin (a temp repo path) are
   substituted over the loaded shape.
5. **Wire it blocking, and cover the handler's source in the path filter.** The handler test
   is a `packages/**` vitest spec, so it runs in the required `packages-tests` job (a
   `ci-required` need — blocking, not advisory). Advisory would not have stopped #2925. The
   subtlety: the job is path-gated, so the `packages` filter in
   [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) must list the handler's *source*
   (today `claude-plugins/fabrika/hooks.json`) — else a hook-only edit skips the gate and the
   guard never runs on the very change class it exists to catch.

## The rule, one line

Capture the real payload before coding to any doc-defined contract; commit it as a golden
fixture; load it verbatim; assert the handler against it; make the test blocking and ensure
its CI job runs whenever the handler's source changes. No `--force`, no fabricated-payload
fallback.
