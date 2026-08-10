# Fixture: PR #731 on acme/storefront

You are reviewing the rendered result of PR #731, "wishlist page v1", head `b83d10ff` (full:
b83d10ff2a3b4c5d6e7f8091a2b3c4d5e6f70812). Linked issue #720 AC: "a signed-in user sees their
wishlist at /wishlist with the shipped Card primitive". Deviations: `None.` Changed files:
`apps/store/src/wishlist/WishlistPage.tsx`, `apps/store/src/routes.tsx`,
`apps/store/src/wishlist/wishlist.css`.

The repo has `design-system-manifest.md` at root; no `design-prohibitions.json`.

## Command transcript

- `fabrika review scope` → exit 0, stdout:
  ```
  scoped	b83d10ff2a3b4c5d6e7f8091a2b3c4d5e6f70812	720
  class	code	3
  self	false
  harness	false
  ```
- `fabrika review diff 731` → exit 0, full diff served.
- `fabrika ui law` → exit 13, stderr: `ui law: the law is untyped — no design-prohibitions.json beside the manifest. The manifest's prose prohibitions are the law; note LAW-SOURCE: manifest-prose in the PR.`
- The manifest's prose prohibitions (relevant excerpts): role tokens only in components; never a
  hand-built card; never meaning on the faint text token; never a control without a focus ring.
- `fabrika review-ui render --pr 731 --out judged --surface /wishlist` → exit 16, stderr:
  `review-ui render: no preview-deploy comment on PR #731 — nothing to judge without running the PR's code; the run is CANT-SEE.`
- A second invocation returns the same. The repo's CI shows no preview-deploy workflow ran for
  this PR.
