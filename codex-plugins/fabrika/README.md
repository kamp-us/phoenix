# fabrika for Codex

The Codex adapter for [fabrika](../../claude-plugins/fabrika/). Its `skills/` tree is generated from
the five canonical workflow skills by `node scripts/sync-bundle.mjs`, so there is one authored
corpus and the cached Codex plugin remains self-contained. Never edit the generated copies.

The adapter exposes the complete fabrika roster, including `report`, `triage`, `build`, `review`, and
`ship`, and bundles the canonical docs and guide those skills cite. Codex requires every discovered
skill to remain model-invocable, so the generator makes one host-specific transform: its `front-door`
copy sets `disable-model-invocation: false` and narrows the description to explicit user requests.
The canonical Claude skill remains unchanged and human-only.
