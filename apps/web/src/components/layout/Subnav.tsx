import * as React from 'react';
import './Subnav.css';

export function Subnav({
  title,
  count,
  filters,
  crumb,
}: {
  title?: React.ReactNode;
  count?: React.ReactNode;
  filters?: React.ReactNode;
  crumb?: { label: React.ReactNode; onClear?: () => void };
}) {
  return (
    <div className="kp-subnav">
      {title ? <span className="kp-subnav__title">{title}</span> : null}
      {count ? <span className="kp-subnav__count">{count}</span> : null}
      {crumb ? (
        <span className="kp-subnav__crumb">
          {crumb.label}
          {crumb.onClear ? (
            <button className="kp-subnav__crumb-clear" onClick={crumb.onClear}>
              × filtreyi kaldır
            </button>
          ) : null}
        </span>
      ) : null}
      <div className="kp-subnav__spacer" />
      {filters ? <div className="kp-subnav__filters">{filters}</div> : null}
    </div>
  );
}

