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

	return (
		<header className="kp-topbar">
			<Link className="kp-topbar__brand" to={brandTo}>
				{before}
				{dotAt >= 0 ? <span className="dot">.</span> : null}
				{after}
			</Link>
			<span className="kp-topbar__sep" />
			{/* NavLink sets aria-current="page" on the active link by default */}
			<nav className="kp-topbar__nav">
				{nav.map((n) => (
					<NavLink key={n.to} to={n.to}>
						{n.label}
					</NavLink>
				))}
				{divanTo ? (
					<NavLink key={divanTo} to={divanTo} data-testid="topbar-divan-link">
						divan
					</NavLink>
				) : null}
			</nav>
			<span className="kp-topbar__spacer" />
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
			{onToggleTheme ? (
				<button type="button" className="kp-topbar__btn" onClick={onToggleTheme}>
					tema
				</button>
			) : null}
			{actions}
			{typeof karma === "number" ? (
				<Karma value={karma} variant="inline" testId="topbar-karma" className="kp-topbar__karma" />
			) : null}
			{user ? (
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
							Profil
						</Menu.Item>
						{bildirim ? (
							<Menu.Item data-testid="topbar-bildirim-link" onClick={() => navigate(bildirim.to)}>
								Bildirimler
							</Menu.Item>
						) : null}
						<Menu.Item onClick={() => navigate("/profile")}>Ayarlar</Menu.Item>
						<Menu.Separator />
						<Menu.Item onClick={onLogout}>Çıkış</Menu.Item>
					</Menu.Popup>
				</Menu.Root>
			) : null}
		</header>
	);
}
