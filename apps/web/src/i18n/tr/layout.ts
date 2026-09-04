/** The app-shell surface: `AppShell`, `Topbar`, `Subnav`, `UserMenu`, `ThemeChoicePicker`. */
export const layout = {
	"layout.skipToContent": "içeriğe geç",
	"layout.search.placeholder": "ara…",
	"layout.search.label": "Ara",
	"layout.divan": "divan",
	"layout.filter.clear": "× filtreyi kaldır",
	"layout.userMenu.profile": "profil",
	"layout.userMenu.bildirimler": "bildirimler",
	"layout.userMenu.settings": "ayarlar",
	"layout.userMenu.theme": "tema",
	"layout.userMenu.locale": "dil",
	"layout.userMenu.logout": "çıkış",
	"layout.theme.light": "açık",
	"layout.theme.dark": "koyu",
	"layout.theme.auto": "otomatik",
	"layout.caylakMeter.vouchFact.yes": "kefil: var",
	"layout.caylakMeter.vouchFact.no": "kefil: yok",
};

/** `tr` is the source of truth for the key set; `en/layout.ts` is checked against this. */
export type LayoutKey = keyof typeof layout;
