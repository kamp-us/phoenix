// State is carried by the word, not color alone (the AA-contrast tokens).

import {Badge} from "./Badge";
import {useDesignT} from "./i18n";
import "./ReviewBadge.css";

/**
 * @component ReviewBadge
 * @whenToUse Every "incelemede" (pending review) badge, wherever it renders — the
 *   author's own sandboxed content (post-detail, definition, profile katkıların) and
 *   the divan review queue. Never hand-roll a second one; a feature class over a raw
 *   `Badge` variant is how the divan chip ended up grey-on-blue (#5228).
 * @slot none Fixed copy; no children slot.
 */
export function ReviewBadge() {
	const t = useDesignT();
	return (
		<Badge variant="info" className="kp-review-badge" data-testid="incelemede-badge">
			{t("ui.reviewBadge")}
		</Badge>
	);
}
