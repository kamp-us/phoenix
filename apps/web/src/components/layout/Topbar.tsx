import type * as React from "react";
import {Link, NavLink, useNavigate} from "react-router";
import {Avatar} from "../ui/Avatar";
import {Menu} from "../ui/Menu";
import "./Topbar.css";

export type NavItem = {to: string; label: string};

export function Topbar({
	brandName = "kamp.us",
	brandTo = "/",
	nav = [],
	user,
	actions,
	onSearchSubmit,
	onToggleTheme,
	onLogout,
}: {
	brandName?: string;
	brandTo?: string;
	nav?: NavItem[];
	/** `username` drives the @username link; null means the bootstrap CTA. */
	user?: {name: string; src?: string; username?: string | null};
	actions?: React.ReactNode;
	onSearchSubmit?: (query: string) => void;
	onToggleTheme?: () => void;
	onLogout?: () => void;
}) {
	const navigate = useNavigate();

	/* Split brand at the first "." so we can accent the dot. */
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
			<nav className="kp-topbar__nav">
				{nav.map((n) => (
					<NavLink
						key={n.to}
						to={n.to}
						aria-current={undefined}
						/* NavLink sets aria-current="page" on match by default */
					>
						{n.label}
					</NavLink>
				))}
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
					aria-hidden
				>
					<circle cx="11" cy="11" r="7" />
					<path d="m20 20-3.5-3.5" />
				</svg>
				<input name="q" placeholder="ara…" aria-label="Ara" />
				<kbd>⌘K</kbd>
			</form>
			{onToggleTheme ? (
				<button type="button" className="kp-topbar__btn" onClick={onToggleTheme}>
					tema
				</button>
			) : null}
			{actions}
			{user?.username ? (
				<Link
					className="kp-topbar__profile-link"
					to={`/u/${user.username}`}
					data-testid="topbar-profile-link"
				>
					@{user.username}
				</Link>
			) : null}
			{user ? (
				<Menu.Root>
					<Menu.Trigger className="kp-topbar__user">
						<Avatar name={user.name} src={user.src} />
						<span>{user.name}</span>
					</Menu.Trigger>
					<Menu.Popup align="end">
						<Menu.Item onClick={() => navigate(user.username ? `/u/${user.username}` : "/profile")}>
							Profil
						</Menu.Item>
						<Menu.Item onClick={() => navigate("/profile")}>Ayarlar</Menu.Item>
						<Menu.Separator />
						<Menu.Item onClick={onLogout}>Çıkış</Menu.Item>
					</Menu.Popup>
				</Menu.Root>
			) : null}
		</header>
	);
}
