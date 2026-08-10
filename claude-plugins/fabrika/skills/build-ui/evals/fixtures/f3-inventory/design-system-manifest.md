# panel — design system manifest
Read before generating any UI.

## Component selection
Reach for the shipped primitive in `src/components/ui/` before writing a new one.
The inventory is `design-system-inventory.md` — select from it; never hand-build a
sibling of a primitive it lists.

## Semantic tokens
`--surface-raised`, `--text-primary`, `--text-muted` (decorative only), spacing scale `--s-1`…`--s-8`.
All in `src/styles/tokens.css`. No raw hex outside it; no raw px over 2px.
