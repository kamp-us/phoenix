import * as React from 'react';
import { Avatar } from '../ui/Avatar';
import { Menu } from '../ui/Menu';
import './Topbar.css';

export type NavItem = { href: string; label: string; current?: boolean };

export function Topbar({
  brand = 'kampüs',
  nav = [],
  user,
  actions,
  onLogout,
}: {
  brand?: React.ReactNode;
  nav?: NavItem[];
  user?: { name: string; src?: string };
  actions?: React.ReactNode;
  onLogout?: () => void;
}) {
  return (
    <header className="kp-topbar">
      <a className="kp-topbar__brand" href="/">{brand}</a>
      <nav className="kp-topbar__nav">
        {nav.map((n) => (
          <a key={n.href} href={n.href} data-current={n.current ? '' : undefined}>
            {n.label}
          </a>
        ))}
      </nav>
      <div className="kp-topbar__spacer" />
      <div className="kp-topbar__actions">
        {actions}
        {user ? (
          <Menu.Root>
            <Menu.Trigger className="kp-topbar__user">
              <Avatar name={user.name} src={user.src} />
              <span>@{user.name}</span>
            </Menu.Trigger>
            <Menu.Popup align="end">
              <Menu.Item>Profil</Menu.Item>
              <Menu.Item>Ayarlar</Menu.Item>
              <Menu.Separator />
              <Menu.Item onClick={onLogout}>Çıkış</Menu.Item>
            </Menu.Popup>
          </Menu.Root>
        ) : null}
      </div>
    </header>
  );
}

