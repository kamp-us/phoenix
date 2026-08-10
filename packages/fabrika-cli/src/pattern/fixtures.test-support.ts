/**
 * The fixture bytes the contract's worked examples are stated against, scripted onto the git seam.
 *
 * The examples name fixtures committed in the skill's own tree, and the read-at-`--base` rule
 * applies to them like anything else — so what a verb actually sees is `git show <sha>:<path>`
 * output. Scripting **those bytes** reproduces the examples through the same seam production uses,
 * and it does so without a checkout: a test that shelled out to a real repository would be asserting
 * against that repository's history rather than against the spec.
 */

/** `.../fixtures/anchored/worker-queue-retry.md` — two declarations, one moved, one unpinned. */
export const ANCHORED_DOC = `# Worker queue retry

The fixture behind \`pattern anchor\`'s \`moved\` outcome. It declares two anchors: one whose package the
fixture manifest pins at a different version, and one the manifest does not carry at all.

> Derived from \`acme-queue@4.1.0\` — re-verify on pin bump.

> Derived from \`@acme/retry@2.0.0\` — re-verify on pin bump.
`;

/** `.../fixtures/anchored/plain-doc.md` — a doc that claims no anchor at all. */
export const PLAIN_DOC = `# Plain doc

A doc carrying no anchor declaration, so \`pattern anchor\` answers \`unanchored\`.
`;

/** `.../fixtures/anchored/workspace.yaml` — pins `acme-queue`, carries no `@acme/retry`. */
export const FIXTURE_MANIFEST = `# Fixture manifest for \`pattern anchor\`'s examples. Not a real workspace.
catalog:
  acme-queue: 4.2.0
  acme-telemetry: 9.9.1
`;

/** `.../fixtures/unanchored-doc/worker-queue-retry.md` — every pointer deliberately unfollowable. */
export const UNANCHORED_DOC = `# Worker queue retry

The fixture behind \`pattern drift\`'s \`unanchored\` outcome: a doc that cites no repo-root-relative
path this verb can follow, so drift here is unanswerable rather than clean.

Every pointer below is deliberately unfollowable — a bare basename, an app-relative fragment, and a
glob — which is exactly the ambiguous shorthand the derivation leaves alone.

- \`retry.ts\`
- \`worker/queue/retry.ts\`
- \`src/**/*.test.ts\`
`;

/** `.../fixtures/three-sections/index.md` — three sections, so the `present:` list is exact. */
export const THREE_SECTIONS_INDEX = `# Patterns

A three-section index fixture, so \`pattern register\`'s refusal example prints an exact list.

## Index — services

| Doc | Topic | Read when |
|---|---|---|
| [cache-invalidation.md](./cache-invalidation.md) | Cache keys and invalidation order | Touching a cached read |

## Index — edge

| Doc | Topic | Read when |
|---|---|---|
| [edge-session-cookies.md](./edge-session-cookies.md) | Session cookie parse and re-issue | Changing session handling |

## Index — observability

| Doc | Topic | Read when |
|---|---|---|
| [tracing-span-names.md](./tracing-span-names.md) | Span naming convention | Naming a new span |
`;

/** The three fixture directory paths the contract's examples pass to `--dir`. */
export const FIXTURES = "claude-plugins/fabrika/skills/write-pattern/evals/fixtures";
