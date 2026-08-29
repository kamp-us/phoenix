# fabrika for Codex

The Codex adapter for [fabrika](../../claude-plugins/fabrika/). Its `skills/` tree is generated from
the complete model-compatible canonical roster by `node scripts/sync-bundle.mjs`, so there is one
authored corpus and the cached Codex plugin remains self-contained. Never edit the generated copies.

The adapter exposes that roster, including `report`, `triage`, `build`, `review`, and `ship`, and
bundles the canonical docs and guide those skills cite. The human-only `front-door` is preserved
unchanged under `references/` for link integrity, outside the discovered `skills/` tree. The generator
rewrites the ADR skill's one relative link to that reference; it does not change skill behavior.
