import * as React from 'react';
import './AppShell.css';

export function AppShell({ children }: { children: React.ReactNode }) {
  return <div className="kp-shell">{children}</div>;
}

export function Main({ children }: { children: React.ReactNode }) {
  return <main className="kp-shell__main">{children}</main>;
}

