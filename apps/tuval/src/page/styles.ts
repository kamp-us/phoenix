/**
 * The page's stylesheet order, in one module so every entry that mounts the page gets the same one.
 *
 * Manti's base first — a `@kampus/design` primitive is a Manti component, and without this its
 * dialog has no positioning at all and lands in the document flow. Then the package's one role-token
 * layer, which the palette, the design primitives and the desk all resolve against. Tuval's own
 * sheet comes after it and declares no role the package owns (#7884) — it carries the desk's chrome
 * and the two tokens the package has no member of (`../shell/ui/tokens.css`).
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
