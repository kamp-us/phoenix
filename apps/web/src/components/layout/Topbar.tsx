import * as React from 'react';
import { Avatar } from '../ui/Avatar';
import { Menu } from '../ui/Menu';
import './Topbar.css';

export type NavItem = { href: string; label: string; current?: boolean };

export function Topbar({
  brandName = 'kamp.us',
  nav = [],
  user,
  actions,
  onBrandClick,
  onSearchSubmit,
  onToggleTheme,
  onLogout,
}: {
  brandName?: string;
  nav?: NavItem[];
  user?: { name: string; src?: string };
  actions?: React.ReactNode;
  onBrandClick?: () => void;
  onSearchSubmit?: (query: string) => void;
  onToggleTheme?: () => void;
  onLogout?: () => void;
}) {
  /* Split brand at the first "." so we can accent the dot. */
  const dotAt = brandName.indexOf('.');
  const before = dotAt >= 0 ? brandName.slice(0, dotAt) : brandName;
  const after = dotAt >= 0 ? brandName.slice(dotAt + 1) : '';

  return (
    <header className="kp-topbar">
      <a
        className="kp-topbar__brand"
        href="/"
        onClick={(e) => {
          if (onBrandClick) {
            e.preventDefault();
            onBrandClick();
          }
        }}
      >
        {before}
        {dotAt >= 0 ? <span className="dot">.</span> : null}
        {after}
      </a>
      <span className="kp-topbar__sep" />
      <nav className="kp-topbar__nav">
        {nav.map((n) => (
          <a key={n.href} href={n.href} aria-current={n.current ? 'page' : undefined}>
            {n.label}
          </a>
        ))}
      </nav>
      <span className="kp-topbar__spacer" />
      <form
        className="kp-topbar__search"
        onSubmit={(e) => {
          e.preventDefault();
          const input = (e.currentTarget.elements.namedItem('q') as HTMLInputElement | null);
          onSearchSubmit?.(input?.value ?? '');
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
      {user ? (
        <Menu.Root>
          <Menu.Trigger className="kp-topbar__user">
            <Avatar name={user.name} src={user.src} />
            <span>{user.name}</span>
          </Menu.Trigger>
          <Menu.Popup align="end">
            <Menu.Item>Profil</Menu.Item>
            <Menu.Item>Ayarlar</Menu.Item>
            <Menu.Separator />
            <Menu.Item onClick={onLogout}>Çıkış</Menu.Item>
          </Menu.Popup>
        </Menu.Root>
      ) : null}
    </header>
  );
}
