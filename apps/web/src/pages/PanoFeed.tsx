import * as React from 'react';
import { Subnav } from '../components/layout/Subnav';
import { PanoCrumb, PanoPostList, type PanoPostData } from '../components/pano/index';

const FILTERS = [
  { id: 'sicak',    label: 'sıcak' },
  { id: 'yeni',     label: 'yeni' },
  { id: 'en-iyi',   label: 'en iyi' },
  { id: 'tartisma', label: 'tartışma' },
];

export function PanoFeed({
  posts,
  host,
}: {
  posts: PanoPostData[];
  host?: string;
}) {
  const [filter, setFilter] = React.useState('sicak');
  const filtered = host ? posts.filter((p) => p.host === host) : posts;

  return (
    <>
      <Subnav
        filters={FILTERS}
        activeFilter={filter}
        onFilterChange={setFilter}
        meta={host ? `${filtered.length} başlık · ${host}` : `${filtered.length} başlık`}
      />
      {host ? <PanoCrumb host={host} /> : null}
      <div className="kp-page">
        <div className="kp-page__inner">
          <PanoPostList posts={filtered} />
        </div>
      </div>
    </>
  );
}
