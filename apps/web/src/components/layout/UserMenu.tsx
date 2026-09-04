/**
 * `UserMenu` — the topbar account disclosure, built on Manti **Popover** rather
 * than Manti Menu.
 *
 * Why not Menu: the tema control is a three-way *segmented* choice
 * ({@link ThemeChoicePicker}, #2612), and a menu is a list of commands — it can
 * only spell that as three stacked menuitems with a ✓ on the active one, which
 * is a different control with different semantics (command vs. radio group).
 * Popover carries arbitrary content, so the picker renders as the labeled
 * settings row it actually is, and keeps its real `radiogroup`/`radio` roles.
 *
 * a11y: the nav rows are real `Link`s and çıkış is a real `button`, so each
 * keeps its native role and keyboard behaviour — this trades Menu's roving
 * `menuitem` focus for plain tab order, which is the correct model for a panel
 * that mixes links with a radio group. Manti Popover supplies the rest
 * (aria-haspopup/expanded on the trigger, Escape-to-close, outside-dismiss).
 */

import {Avatar, Button, Popover} from "@kampus/design";
import {useState} from "react";
import {Link} from "react-router";
import {FlagGate} from "../../flags/FlagGate";
import {PHOENIX_LOCALE} from "../../flags/keys";
import {useLocale, useT} from "../../i18n";
import type {ThemeChoice} from "../../lib/theme";
import {LocaleChoicePicker} from "./LocaleChoicePicker";
import {ThemeChoicePicker} from "./ThemeChoicePicker";
import "./UserMenu.css";

export function UserMenu({
	user,
	bildirim,
	themeChoice,
	onThemeChange,
	onLogout,
}: {
	user: {name: string; src?: string; username?: string | null};
	bildirim?: {to: string};
	themeChoice?: ThemeChoice;
	onThemeChange?: (choice: ThemeChoice) => void;
	onLogout?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const close = () => setOpen(false);
	const t = useT();
	// Read off the context rather than drilled through Topbar like `themeChoice`: the locale
	// already has an app-level provider, so a prop pair would be a second source for one value.
	const {locale, setLocale} = useLocale();

	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
			placement="bottom-end"
			className="kp-user-menu__popup"
			trigger={
				<Button type="button" variant="tertiary" size="sm" className="kp-topbar__user">
					<Avatar name={user.name} src={user.src} />
					<span>{user.name}</span>
					{/* No unread badge on the trigger: the count lives on the status-zone bell
					    (`bildirimSignal`), its one lawful zone (#2613). */}
				</Button>
			}
		>
			<nav className="kp-user-menu__nav">
				<Link
					className="kp-user-menu__item"
					to={user.username ? `/u/${user.username}` : "/profile"}
					onClick={close}
					data-testid="topbar-profile-link"
				>
					{t("layout.userMenu.profile")}
				</Link>
				{bildirim ? (
					<Link
						className="kp-user-menu__item"
						to={bildirim.to}
						onClick={close}
						data-testid="topbar-bildirim-link"
					>
						{t("layout.userMenu.bildirimler")}
					</Link>
				) : null}
				<Link className="kp-user-menu__item" to="/profile" onClick={close}>
					{t("layout.userMenu.settings")}
				</Link>
			</nav>
			{themeChoice && onThemeChange ? (
				<div className="kp-user-menu__setting-row" data-testid="topbar-theme-row">
					<span className="kp-user-menu__setting-label">{t("layout.userMenu.theme")}</span>
					<ThemeChoicePicker
						choice={themeChoice}
						onChange={onThemeChange}
						testId="topbar-theme-picker"
					/>
				</div>
			) : null}
			{/* Dark until the human release flip (ADR 0083): with the flag off no toggle renders
			    and every reader stays on the `tr` default, which is today's copy exactly. */}
			<FlagGate flag={PHOENIX_LOCALE}>
				<div className="kp-user-menu__setting-row" data-testid="topbar-locale-row">
					<span className="kp-user-menu__setting-label">{t("layout.userMenu.locale")}</span>
					<LocaleChoicePicker locale={locale} onChange={setLocale} testId="topbar-locale-picker" />
				</div>
			</FlagGate>
			<hr className="kp-user-menu__sep" />
			{/* The Button primitive, not a bare <button> — the Manti-adoption guard rules out raw
			    interactive controls, and going through it also means global.css's plain-button
			    reset (which zeroes padding on `button:not([data-scope][data-part])`) no longer
			    applies here, so the row keeps the shared box without outranking anything. */}
			<Button
				type="button"
				variant="tertiary"
				className="kp-user-menu__item kp-user-menu__item--action"
				onClick={() => {
					close();
					onLogout?.();
				}}
			>
				{t("layout.userMenu.logout")}
			</Button>
		</Popover>
	);
}
