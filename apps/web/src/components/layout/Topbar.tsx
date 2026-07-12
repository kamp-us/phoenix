import type * as React from "react";
import {useEffect, useRef} from "react";
import {Link, NavLink, useNavigate} from "react-router";
import {isSearchShortcut} from "../../lib/searchShortcut";
import {formatUnreadBadge, showUnreadBadge} from "../bildirim/bildirim";
import {Karma} from "../karma/Karma";
import {Avatar} from "../ui/Avatar";
import {Menu} from "../ui/Menu";
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
	onToggleTheme,
	onLogout,
	navIa = false,
}: {
	brandName?: string;
	brandTo?: string;
	nav?: NavItem[];
	/**
	 * The yazar/mod-only divan entry's href (#1290). Rendered only when set — the
	 * Layout passes it solely when the authorship-loop flag is on AND the server
	 * granted divan access (yazar OR mod), so it is invisible to çaylak/visitor and
	 * absent when the flag is off. Kept distinct from `nav` so the gated entry never
	 * leaks into the always-on nav list.
	 */
	divanTo?: string;
	/** `username` drives the @username link; null means the bootstrap CTA. */
	user?: {name: string; src?: string; username?: string | null};
	/**
	 * The signed-in user's ambient self-karma (#1208). Rendered only when present —
	 * the Layout passes it solely behind the authorship-loop flag, so when the flag
	 * is off it is `undefined` and the topbar is exactly as before.
	 */
	karma?: number;
	/**
	 * The bildirim entry (#1694). Rendered only when set — the Layout passes it
	 * solely when the `phoenix-bildirim` flag is on AND the viewer is signed in,
	 * so with the flag off (the dark default) the topbar is exactly as before.
	 * The unread chip on the trigger renders only when `unread > 0` (the AC).
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
	onToggleTheme?: () => void;
	onLogout?: () => void;
	/**
	 * The nav-IA restructure seam (#2611, epic #2595) — the shared default-off
	 * `phoenix-nav-ia` flag #2600 rides. Off (the default) ⇒ the topbar renders its
	 * pre-restructure shape, byte-identical to today. On ⇒ every surviving element is
	 * classed by the #2586 taxonomy (destination / utility / status-signal /
	 * primary-action) and rendered inside its one lawful zone (the #2587 Model-2 zone
	 * grammar). The two states are total — the flag either fully reclasses or leaves the
	 * topbar untouched, never a half-migrated mix. This child establishes the zones +
	 * classes + flag substrate the tema/status/accent-scarcity children (#2612–#2614)
	 * build on; it does no status-affordance rework of its own.
	 */
	navIa?: boolean;
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

	// The topbar's leaf elements, built once and arranged by the flag branch below. The
	// off/on renders share these exact nodes, so `navIa` decides only *which zone* each
	// sits in — never a second, drifting copy of the search form or user menu.
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
	// Under the zone grammar divan leaves `.kp-topbar__nav`, so it carries
	// `kp-topbar__signal-link` to keep the nav-link treatment (grouped in the CSS). Off,
	// it stays inside the nav and needs no class — omitting it keeps the flag-off DOM
	// byte-identical to today (`undefined` renders no `class` attribute).
	const divanLink = divanTo ? (
		<NavLink
			key={divanTo}
			to={divanTo}
			data-testid="topbar-divan-link"
			className={navIa ? "kp-topbar__signal-link" : undefined}
		>
			divan
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
	const themeButton = onToggleTheme ? (
		<button type="button" className="kp-topbar__btn" onClick={onToggleTheme}>
			tema
		</button>
	) : null;
	const karmaChip =
		typeof karma === "number" ? (
			<Karma value={karma} variant="inline" testId="topbar-karma" className="kp-topbar__karma" />
		) : null;
	const userMenu = user ? (
		<Menu.Root>
			<Menu.Trigger className="kp-topbar__user">
				<Avatar name={user.name} src={user.src} />
				<span>{user.name}</span>
				{bildirim && showUnreadBadge(bildirim.unread) ? (
					<span
						className="kp-topbar__bildirim-badge"
						data-testid="topbar-bildirim-badge"
						role="status"
						aria-label={`${bildirim.unread} okunmamış bildirim`}
					>
						{formatUnreadBadge(bildirim.unread)}
					</span>
				) : null}
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
				<Menu.Separator />
				<Menu.Item onClick={onLogout}>çıkış</Menu.Item>
			</Menu.Popup>
		</Menu.Root>
	) : null;

	// Nav-IA zone grammar (#2611): every element is classed by the #2586 taxonomy and
	// placed in its one lawful zone (#2587 Model-2). Zones carry a stable class +
	// data-testid so the structure is headlessly targetable; brand + account (actions /
	// user menu) are the structural spine, not a taxonomy class. The primary-action zone
	// is empty/reserved — #2600 relocated the promoted `+ gönderi` verb to the pano
	// Subnav CTA, so no product-scoped occupant lives in the global bar (it does not
	// re-add one). divan/karma move into the status-signal zone here; their affordance
	// rework is the status/signal child's (#2613) job, not this spine's.
	if (navIa) {
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
					{themeButton}
				</div>
				<div
					className="kp-topbar__zone kp-topbar__zone--status-signal"
					data-testid="topbar-zone-status-signal"
				>
					{divanLink}
					{karmaChip}
				</div>
				{actions}
				{userMenu}
			</header>
		);
	}

	// Flag off — the pre-restructure topbar, byte-identical to today. divan renders back
	// inside the destination nav (its `kp-topbar__signal-link` class only takes effect
	// under the zone grammar, where the nav-link treatment is grouped onto it).
	return (
		<header className="kp-topbar">
			{brand}
			<span className="kp-topbar__sep" />
			<nav className="kp-topbar__nav">
				{destinationLinks}
				{divanLink}
			</nav>
			<span className="kp-topbar__spacer" />
			{searchForm}
			{themeButton}
			{actions}
			{karmaChip}
			{userMenu}
		</header>
	);
}
