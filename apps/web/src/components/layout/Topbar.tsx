import {Gavel} from "lucide-react";
import type * as React from "react";
import {useEffect, useRef} from "react";
import {Link, NavLink, useNavigate} from "react-router";
import {isSearchShortcut} from "../../lib/searchShortcut";
import type {ThemeChoice} from "../../lib/theme";
import {BildirimPopover} from "../bildirim/BildirimPopover";
import {showUnreadBadge} from "../bildirim/bildirim";
import {Icon} from "../Icon";
import {Karma} from "../karma/Karma";
import {Avatar} from "../ui/Avatar";
import {Menu} from "../ui/Menu";
import {ThemeChoicePicker} from "./ThemeChoicePicker";
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
	/**
	 * The yazar/mod-only divan entry's href (#1290). Rendered only when set — the
	 * Layout passes it solely when the server granted divan access (yazar OR mod), so
	 * it is invisible to çaylak/visitor. Kept distinct from `nav` so the gated entry
	 * never leaks into the always-on nav list.
	 */
	divanTo?: string;
	/** `username` drives the @username link; null means the bootstrap CTA. */
	user?: {name: string; src?: string; username?: string | null};
	/**
	 * The signed-in user's ambient self-karma (#1208). Rendered only when present —
	 * `undefined` for a signed-out viewer, whose topbar carries no karma.
	 */
	karma?: number;
	/**
	 * The bildirim entry (#1694). Rendered only when set — the Layout passes it
	 * solely when the `phoenix-bildirim` flag is on AND the viewer is signed in,
	 * so with the flag off (the dark default) the topbar is exactly as before.
	 * The unread signal renders only when `unread > 0`, as the status-zone bell (#2613).
	 */
	bildirim?: {to: string; unread: number};
	actions?: React.ReactNode;
	/**
	 * The active search query to echo in the header input on the results page
	 * (#2199) — seeded from the URL `q` by the Layout only on `/search`, empty
	 * elsewhere. It keys an uncontrolled `defaultValue` (below), so the field
	 * stays freely editable and a query→query navigation re-seeds it.
	 */
	searchQuery?: string;
	onSearchSubmit?: (query: string) => void;
	/**
	 * The current theme selection + its setter, driving the three-way theme picker
	 * (light/dark/auto) — the sole theme control (#2612). The picker renders in the user
	 * menu for a signed-in visitor and in the utility zone for a signed-out one, so every
	 * visitor keeps exactly one theme control.
	 */
	themeChoice?: ThemeChoice;
	onThemeChange?: (choice: ThemeChoice) => void;
	onLogout?: () => void;
	/**
	 * Reserve the signed-in account cluster's geometry at first paint (#2933, ADR 0179 §1).
	 * Driven by `__BOOT__.user != null` (`readBootUser`, ADR 0185) in the shell frame: when the
	 * edge resolved a signed-in session, the account slot holds its geometry from the first frame.
	 * With `__BOOT__.user` present the shell also seeds the real `user` chip synchronously, so the
	 * cluster paints its content immediately rather than a placeholder; this placeholder covers the
	 * residual reserve-without-content window (a boot/session divergence). False (absent `__BOOT__`
	 * / signed-out) ⇒ the account slot stays null until `user` arrives — today's conditional render.
	 */
	reserveSignedInSlots?: boolean;
}) {
	const navigate = useNavigate();
	const searchInputRef = useRef<HTMLInputElement>(null);

	// ⌘K (mac) / Ctrl+K (other) focuses search, backing the <kbd>⌘K</kbd> hint below.
	// preventDefault overrides the browser's own ⌘/Ctrl+K (address-bar) binding.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (!isSearchShortcut(e)) return;
			e.preventDefault();
			searchInputRef.current?.focus();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	const dotAt = brandName.indexOf(".");
	const before = dotAt >= 0 ? brandName.slice(0, dotAt) : brandName;
	const after = dotAt >= 0 ? brandName.slice(dotAt + 1) : "";

	// The topbar's leaf elements, built once and placed into their zones below — one node
	// each, never a second drifting copy of the search form or user menu.
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
	// Under the zone grammar divan is a status/signal glyph (#2613): a gated signal, not a
	// peer product noun, so it sits in the status zone rather than `.kp-topbar__nav` and reads
	// as the canonical Gavel icon (ADR 0166) under an accessible "divan" name, carrying the
	// `kp-topbar__signal-link` treatment (grouped in the CSS). Null when the caller passes no
	// `divanTo` — the access probe (#1290) withholds it from a viewer without divan access.
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
			<svg
				width="11"
				height="11"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2.4"
				aria-hidden="true"
			>
				<circle cx="11" cy="11" r="7" />
				<path d="m20 20-3.5-3.5" />
			</svg>
			{/* key + defaultValue: uncontrolled so it stays editable, yet a query→query
			    navigation re-seeds the echoed value by remounting with the new default. */}
			<input
				key={searchQuery}
				ref={searchInputRef}
				name="q"
				defaultValue={searchQuery}
				placeholder="ara…"
				aria-label="Ara"
			/>
			<kbd>⌘K</kbd>
		</form>
	);
	// The three-way theme picker (#2612) — the sole theme control. Signed-in ⇒ it lives in
	// the user menu next to `ayarlar`; signed-out ⇒ in the utility zone, so exactly one
	// renders either way. Null unless the caller wires both halves of the controlled pair.
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
	// The unread bildirim signal in the status zone (#2613), now an INTERACTIVE bell that
	// opens an in-place popover of recent bildirimler (#2787) — the near-universal
	// bell→dropdown pattern, with the full `/bildirimler` page kept as the "tümünü gör"
	// destination. The count is still the trigger's accessible name (ADR 0166). Same render
	// rule as before — only when the `phoenix-bildirim` flag put a `bildirim` here AND
	// unread > 0.
	const bildirimSignal =
		bildirim && showUnreadBadge(bildirim.unread) ? (
			<BildirimPopover to={bildirim.to} unread={bildirim.unread} />
		) : null;
	const userMenu = user ? (
		<Menu.Root>
			<Menu.Trigger className="kp-topbar__user">
				<Avatar name={user.name} src={user.src} />
				<span>{user.name}</span>
				{/* No unread badge on the trigger: the count lives on the status-zone bell
				    (`bildirimSignal`), its one lawful zone (#2613). */}
			</Menu.Trigger>
			<Menu.Popup align="end">
				<Menu.Item
					data-testid="topbar-profile-link"
					onClick={() => navigate(user.username ? `/u/${user.username}` : "/profile")}
				>
					profil
				</Menu.Item>
				{bildirim ? (
					<Menu.Item data-testid="topbar-bildirim-link" onClick={() => navigate(bildirim.to)}>
						bildirimler
					</Menu.Item>
				) : null}
				<Menu.Item onClick={() => navigate("/profile")}>ayarlar</Menu.Item>
				{themePicker ? (
					<div className="kp-topbar__theme-row" data-testid="topbar-theme-row">
						<span className="kp-topbar__theme-label">tema</span>
						{themePicker}
					</div>
				) : null}
				<Menu.Separator />
				<Menu.Item onClick={onLogout}>çıkış</Menu.Item>
			</Menu.Popup>
		</Menu.Root>
	) : null;
	// The account slot: the real user menu once fate publishes it, else — when `__BOOT__`
	// reserved a signed-in first paint — a fixed-geometry placeholder that holds the slot open
	// so the menu late-fills in place with no shift (#2933). Mirrors `.kp-topbar__user`'s box
	// (avatar + name) and is inert (aria-hidden, not a control). Signed-out / no reservation ⇒
	// null, exactly today's render.
	const accountSlot =
		userMenu ??
		(reserveSignedInSlots ? (
			<span
				className="kp-topbar__user kp-topbar__user--placeholder"
				data-testid="topbar-user-placeholder"
				aria-hidden="true"
			>
				<span className="kp-avatar" />
				<span className="kp-topbar__name-placeholder" />
			</span>
		) : null);

	// Nav-IA zone grammar (#2611): every element is classed by the #2586 taxonomy and
	// placed in its one lawful zone (#2587 Model-2). Zones carry a stable class +
	// data-testid so the structure is headlessly targetable; brand + account (actions /
	// user menu) are the structural spine, not a taxonomy class. The primary-action zone
	// is empty/reserved — #2600 relocated the promoted `+ gönderi` verb to the pano
	// Subnav CTA, so no product-scoped occupant lives in the global bar (it does not
	// re-add one). The status-signal zone carries the read-only signals reworked in #2613:
	// the divan glyph, the karma glyph, and the bildirim bell — each a legible affordance in
	// its lawful zone, none a control or accent.
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
