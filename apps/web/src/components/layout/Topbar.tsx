import {Gavel, Search} from "lucide-react";
import type * as React from "react";
import {useEffect} from "react";
import {Link, NavLink} from "react-router";
import {isSearchShortcut} from "../../lib/searchShortcut";
import type {ThemeChoice} from "../../lib/theme";
import {BildirimPopover} from "../bildirim/BildirimPopover";
import {showUnreadBadge} from "../bildirim/bildirim";
import {Icon} from "../Icon";
import {Karma} from "../karma/Karma";
import {Kbd} from "../ui/atoms";
import {Input} from "../ui/Form";
import {ThemeChoicePicker} from "./ThemeChoicePicker";
import {UserMenu} from "./UserMenu";
import "./Topbar.css";

export type NavItem = {to: string; label: string};

export function Topbar({
	brandName = "kamp.us",
	brandTo = "/",
	nav = [],
	divanTo,
	user,
	karma,
	bildirim,
	actions,
	searchQuery = "",
	onSearchSubmit,
	themeChoice,
	onThemeChange,
	onLogout,
	reserveSignedInSlots = false,
}: {
	brandName?: string;
	brandTo?: string;
	nav?: NavItem[];
	divanTo?: string;
	user?: {name: string; src?: string; username?: string | null};
	karma?: number;
	bildirim?: {to: string; unread: number};
	actions?: React.ReactNode;
	searchQuery?: string;
	onSearchSubmit?: (query: string) => void;
	themeChoice?: ThemeChoice;
	onThemeChange?: (choice: ThemeChoice) => void;
	onLogout?: () => void;
	// The account side is claimed — gates the pill as well as its placeholder, so a caller that
	// also renders a sign-in CTA must derive that CTA from this flag's negation (#6660).
	reserveSignedInSlots?: boolean;
}) {
	// ⌘K (mac) / Ctrl+K (other) focuses search, backing the <Kbd>⌘K</Kbd> hint below.
	// preventDefault overrides the browser's own ⌘/Ctrl+K (address-bar) binding.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (!isSearchShortcut(e)) return;
			e.preventDefault();
			document.querySelector<HTMLInputElement>("#topbar-search")?.focus();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const dotAt = brandName.indexOf(".");
	const before = dotAt >= 0 ? brandName.slice(0, dotAt) : brandName;
	const after = dotAt >= 0 ? brandName.slice(dotAt + 1) : "";

	const brand = (
		<Link className="kp-topbar__brand" to={brandTo}>
			{before}
			{dotAt >= 0 ? <span className="dot">.</span> : null}
			{after}
		</Link>
	);
	// NavLink sets aria-current="page" on the active link by default.
	const destinationLinks = nav.map((n) => (
		<NavLink key={n.to} to={n.to}>
			{n.label}
		</NavLink>
	));
	// divan is a status glyph, not a peer product noun, so it belongs in the status zone and not
	// `.kp-topbar__nav`. See ADR 0176 for the zone law, ADR 0166 for the icon.
	const divanLink = divanTo ? (
		<NavLink
			key={divanTo}
			to={divanTo}
			data-testid="topbar-divan-link"
			className="kp-topbar__signal-link"
			aria-label="divan"
			title="divan"
		>
			<Icon icon={Gavel} size={16} />
		</NavLink>
	) : null;
	const searchForm = (
		<form
			className="kp-topbar__search"
			onSubmit={(e) => {
				e.preventDefault();
				const input = e.currentTarget.elements.namedItem("q") as HTMLInputElement | null;
				onSearchSubmit?.(input?.value ?? "");
			}}
		>
			{/* key + defaultValue: uncontrolled so it stays editable, yet a query→query
			    navigation re-seeds the echoed value by remounting with the new default. */}
			{/* The magnifier and the keycap ride the field's own `left`/`right` slots rather than
			    sitting beside it. They land inside [data-part="control"], which is the element
			    global.css paints the focus ring on — hand-rolling the group put the ring on a box
			    that was not the one drawing the border (#5660). Size 12 is below ADR 0166 §4's
			    floor on purpose: ADR 0240's labelled-glyph tier names this exact call site, since
			    the adjacent `ara…` placeholder already carries the meaning. */}
			<Input
				key={searchQuery}
				id="topbar-search"
				className="kp-topbar__search-field"
				name="q"
				defaultValue={searchQuery}
				placeholder="ara…"
				aria-label="Ara"
				fullWidth
				left={<Icon icon={Search} size={12} />}
				right={<Kbd>⌘K</Kbd>}
			/>
		</form>
	);
	const themePicker =
		themeChoice && onThemeChange ? (
			<ThemeChoicePicker
				choice={themeChoice}
				onChange={onThemeChange}
				testId="topbar-theme-picker"
			/>
		) : null;
	const karmaChip =
		typeof karma === "number" ? (
			<Karma value={karma} variant="inline" testId="topbar-karma" className="kp-topbar__karma" />
		) : null;
	const bildirimSignal =
		bildirim && showUnreadBadge(bildirim.unread) ? (
			<BildirimPopover to={bildirim.to} unread={bildirim.unread} />
		) : null;
	const userMenu = user ? (
		<UserMenu
			user={user}
			bildirim={bildirim}
			themeChoice={themeChoice}
			onThemeChange={onThemeChange}
			onLogout={onLogout}
		/>
	) : null;
	// `reserveSignedInSlots` gates the whole account side, pill included. The caller derives its
	// sign-in CTA from the negation of this same flag, so gating only the placeholder left the
	// pill riding a truthy `user` prop that a signed-out caller could still supply — pill and CTA
	// on screen together (#6660). Inside the gate the placeholder holds the slot's geometry until
	// the real user arrives, so the menu fills in place with no shift. See ADR 0179 §1, ADR 0185.
	const accountSlot = reserveSignedInSlots
		? (userMenu ?? (
				<span
					className="kp-topbar__user kp-topbar__user--placeholder"
					data-testid="topbar-user-placeholder"
					aria-hidden="true"
				>
					<span className="kp-avatar" />
					<span className="kp-topbar__name-placeholder" />
				</span>
			))
		: null;

	// Every element sits in its one lawful zone (see ADR 0176). The primary-action zone is
	// empty on purpose — #2600 moved `+ gönderi` to the pano Subnav CTA; do not refill it.
	return (
		<header className="kp-topbar">
			{brand}
			<span className="kp-topbar__sep" />
			<div
				className="kp-topbar__zone kp-topbar__zone--destination"
				data-testid="topbar-zone-destination"
			>
				<nav className="kp-topbar__nav">{destinationLinks}</nav>
			</div>
			<span
				className="kp-topbar__zone kp-topbar__zone--primary-action"
				data-testid="topbar-zone-primary-action"
				aria-hidden="true"
			/>
			<span className="kp-topbar__spacer" />
			<div className="kp-topbar__zone kp-topbar__zone--utility" data-testid="topbar-zone-utility">
				{searchForm}
				{/* Signed-out visitors reach the theme picker here; signed-in ones in the user
				    menu (above), so exactly one theme control renders either way (#2612). */}
				{!user ? themePicker : null}
			</div>
			<div
				className="kp-topbar__zone kp-topbar__zone--status-signal"
				data-testid="topbar-zone-status-signal"
			>
				{divanLink}
				{karmaChip}
				{bildirimSignal}
			</div>
			{actions}
			{accountSlot}
		</header>
	);
}
