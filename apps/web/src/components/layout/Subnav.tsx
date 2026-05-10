import * as React from 'react';
import './Subnav.css';

export type SubnavFilter = { id: string; label: React.ReactNode };

export function Subnav({
  title,
  count,
  filters,
  activeFilter,
  onFilterChange,
  crumb,
  meta,
}: {
  title?: React.ReactNode;
  count?: React.ReactNode;
  filters?: SubnavFilter[];
  activeFilter?: string;
  onFilterChange?: (id: string) => void;
  crumb?: { label: React.ReactNode; onClear?: () => void };
  meta?: React.ReactNode;
}) {
  return (
    <div className="kp-subnav">
      {filters?.length ? (
        <div className="kp-subnav__filters">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              className="kp-subnav__filter"
              aria-pressed={activeFilter === f.id}
              onClick={() => onFilterChange?.(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      ) : null}
      {title ? <span className="kp-subnav__title">{title}</span> : null}
      {crumb ? (
        <span className="kp-subnav__crumb">
          {crumb.label}
          {crumb.onClear ? (
            <button
              type="button"
              className="kp-subnav__crumb-clear"
              onClick={crumb.onClear}
            >
              × filtreyi kaldır
            </button>
          ) : null}
        </span>
      ) : null}
      <span className="kp-subnav__spacer" />
      {count ? <span className="kp-subnav__meta">{count}</span> : null}
      {meta ? <span className="kp-subnav__meta">{meta}</span> : null}
    </div>
  );
}
