# okuma — design system manifest
The design law of this repo. Agents read this before generating any UI.

## Semantic token annotations
| Role | Token | Notes |
|---|---|---|
| page surface | `--surface-page` | never raw hex |
| card surface | `--surface-raised` | never raw hex |
| body text | `--text-primary` | |
| subdued text | `--text-muted` | decorative only — never meaning-carrying |
| accent | `--accent` | interactive affordances only |
| spacing scale | `--s-1` … `--s-8` | ALL spacing/sizing derives from the scale: use `var(--s-n)` or `calc(var(--s-n) * k)`. Raw px is sanctioned only at 1px/2px (hairlines). |

## Prohibitions
- No hex literal outside `src/styles/tokens.css`.
- No raw px value over 2px anywhere: widths, margins, paddings, font sizes all derive from the scale.
- Meaning-carrying text never sits on `--text-muted`.
- Every interactive control has a visible `:focus-visible` ring using `--focus-ring`.
