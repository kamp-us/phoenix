import type {LayoutKey} from "../tr/layout";

// Lowercase like the Turkish side: the shell's voice is lowercase chrome, and a locale swap
// changes the language, never the typographic voice. divan reads "Council" here, and the other
// Turkish words are translated (ADR 0414) — `brandNouns.unit.test.ts` is what holds that.
export const layout = {
	"layout.skipToContent": "skip to content",
	"layout.search.placeholder": "search…",
	"layout.search.label": "Search",
	"layout.divan": "Council",
	"layout.filter.clear": "× clear filter",
	"layout.breadcrumb.label": "breadcrumb",
	"layout.userMenu.profile": "profile",
	"layout.userMenu.bildirimler": "notifications",
	"layout.userMenu.settings": "settings",
	"layout.userMenu.theme": "theme",
	"layout.userMenu.locale": "language",
	"layout.userMenu.logout": "log out",
	"layout.theme.light": "light",
	"layout.theme.dark": "dark",
	"layout.theme.auto": "auto",
	"layout.caylakMeter.vouchFact.yes": "vouched: yes",
	"layout.caylakMeter.vouchFact.no": "vouched: no",
} satisfies Record<LayoutKey, string>;
