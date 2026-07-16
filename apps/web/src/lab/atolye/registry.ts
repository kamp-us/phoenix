/**
 * The exhibit registry — the headless seam of atölye. A plain typed array the index route
 * (#3092), the detail route (#3093), and a test/agent all import to enumerate or resolve an
 * exhibit without rendering. Adding an exhibit is one colocated `*.exhibit.tsx` module plus
 * one line here; the array order IS the curation order. No route ever edits to gain a piece.
 */

import type {AnyExhibit} from "./exhibit";
import {avatarExhibit} from "./exhibits/Avatar.exhibit";
import {buttonExhibit} from "./exhibits/Button.exhibit";
import {cardExhibit} from "./exhibits/Card.exhibit";
import {collapsibleExhibit} from "./exhibits/Collapsible.exhibit";
import {copyLinkButtonExhibit} from "./exhibits/CopyLinkButton.exhibit";
import {countToggleExhibit} from "./exhibits/CountToggle.exhibit";
import {dialogExhibit} from "./exhibits/Dialog.exhibit";
import {draftRestoreBannerExhibit} from "./exhibits/DraftRestoreBanner.exhibit";
import {editedIndicatorExhibit} from "./exhibits/EditedIndicator.exhibit";
import {emptyStateExhibit} from "./exhibits/EmptyState.exhibit";
import {formExhibit} from "./exhibits/Form.exhibit";
import {menuExhibit} from "./exhibits/Menu.exhibit";
import {metaRowExhibit} from "./exhibits/MetaRow.exhibit";
import {reportButtonExhibit} from "./exhibits/ReportButton.exhibit";
import {reviewBadgeExhibit} from "./exhibits/ReviewBadge.exhibit";
import {switchExhibit} from "./exhibits/Switch.exhibit";
import {tabsExhibit} from "./exhibits/Tabs.exhibit";
import {toastExhibit} from "./exhibits/Toast.exhibit";
import {toggleGroupExhibit} from "./exhibits/ToggleGroup.exhibit";
import {tooltipExhibit} from "./exhibits/Tooltip.exhibit";

const exhibits: readonly AnyExhibit[] = [
	buttonExhibit,
	avatarExhibit,
	cardExhibit,
	collapsibleExhibit,
	copyLinkButtonExhibit,
	countToggleExhibit,
	dialogExhibit,
	draftRestoreBannerExhibit,
	editedIndicatorExhibit,
	emptyStateExhibit,
	formExhibit,
	menuExhibit,
	metaRowExhibit,
	reportButtonExhibit,
	reviewBadgeExhibit,
	switchExhibit,
	tabsExhibit,
	toastExhibit,
	toggleGroupExhibit,
	tooltipExhibit,
];

/** Every registered exhibit, in curated order — headless, renders nothing. */
export function listExhibits(): readonly AnyExhibit[] {
	return exhibits;
}

/** Resolve one exhibit by its slug; `undefined` for an unknown id (the detail route's not-found). */
export function getExhibit(id: string): AnyExhibit | undefined {
	return exhibits.find((exhibit) => exhibit.id === id);
}
