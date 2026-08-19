// The headless registry — the array order IS the curation order. See .patterns/atolye-exhibit-harness.md

import type {AnyExhibit} from "./exhibit";
import {avatarExhibit} from "./exhibits/Avatar.exhibit";
import {buttonExhibit} from "./exhibits/Button.exhibit";
import {cardExhibit} from "./exhibits/Card.exhibit";
import {collapsibleExhibit} from "./exhibits/Collapsible.exhibit";
import {composerExhibit} from "./exhibits/Composer.exhibit";
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
	// The composer leads the catalog — atölye's first feature-level exhibit (#3095), ahead of
	// the UI primitives it is built from.
	composerExhibit,
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

export function listExhibits(): readonly AnyExhibit[] {
	return exhibits;
}

export function getExhibit(id: string): AnyExhibit | undefined {
	return exhibits.find((exhibit) => exhibit.id === id);
}
