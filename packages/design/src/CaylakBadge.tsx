// The reader-facing çaylak marker (#6427, epic #4306) — the ONE renderer of the
// `sandboxedInPlace` wire field (#6425), on every surface an opted-in yazar now meets
// çaylak work: the pano feed row, the post detail, the comment tree node, and the sözlük
// definition entry. Sibling of `ReviewBadge`, never a rename of it: that badge tells an
// AUTHOR their own item is in review, this one tells a READER whose item they are reading.
// Which of the two renders on a given item is `SandboxMarker`'s decision, not a call site's.

import {Badge} from "./Badge";
import {useDesignT} from "./i18n";
import "./CaylakBadge.css";
import "./visually-hidden.css";

/**
 * @component CaylakBadge
 * @whenToUse Never directly — reach for `SandboxMarker`, which owns the ReviewBadge/CaylakBadge
 *   choice so the two cannot stack on one item. Rendered only when the server-derived
 *   `sandboxedInPlace` field is true, which is structurally false while
 *   `PHOENIX_CAYLAK_VISIBILITY` is off.
 * @slot none Fixed copy; no children slot.
 */
export function CaylakBadge() {
	const t = useDesignT();
	return (
		<Badge variant="secondary" className="kp-caylak-badge" data-testid="caylak-badge">
			{t("ui.caylakBadge")}
			{/* The visible words name the item; the hidden clause gives a screen-reader listener the
			    stage too, which sighted readers get from the quiet chip treatment. */}
			<span className="kp-visually-hidden">{t("ui.caylakBadge.stage")}</span>
		</Badge>
	);
}
