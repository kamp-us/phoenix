/**
 * The page's stylesheet order, in one module so every entry that mounts the page gets the same one.
 *
 * Manti's base first — a `@kampus/design` primitive is a Manti component, and without this its
 * dialog has no positioning at all and lands in the document flow. Then the design token layer, then
 * Tuval's: both declare role tokens at `:root` and the desk's own values have to win that tie. The
 * design layer is what the palette resolves against (`../palette/palette.css`); the desk keeps its
 * dark-only scale (`../shell/ui/tokens.css`).
 *
 * Tuval's own markup carries `kp-visually-hidden` too (`../shell/chat/ToolRow.tsx`), so the page
 * takes the package's rule directly rather than inheriting it from whichever design component
 * happens to be in the bundle (#7984).
 */

import "@manti-ui/styles/index.css";
import "@kampus/design/fonts.css";
import "@kampus/design/tokens.css";
import "@kampus/design/visually-hidden.css";
import "../shell/ui/tokens.css";
import "./page.css";
