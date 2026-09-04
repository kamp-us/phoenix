// The one badge slot for an item's sandbox state (#6427) — every content surface renders
// this instead of picking `ReviewBadge` or `CaylakBadge` itself, so the "at most one badge,
// owner's wins" ruling lives in `sandboxMarker` rather than in four hand-synced ternaries.
import {CaylakBadge} from "./CaylakBadge";
import {ReviewBadge} from "./ReviewBadge";
import {type SandboxMarkerInput, sandboxMarker} from "./sandbox-marker";

/**
 * @component SandboxMarker
 * @whenToUse Any surface showing content that can be sandboxed — the pano feed row, post
 *   detail, comment tree node, sözlük definition entry. Renders nothing when neither wire
 *   field applies, which is also what every viewer gets with `PHOENIX_CAYLAK_VISIBILITY` off.
 * @slot none Chooses a fixed-copy badge; no children slot.
 */
export function SandboxMarker(props: SandboxMarkerInput) {
	switch (sandboxMarker(props)) {
		case "review":
			return <ReviewBadge />;
		case "caylak":
			return <CaylakBadge />;
		case "none":
			return null;
	}
}
