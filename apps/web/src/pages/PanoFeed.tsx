import * as React from 'react';
import { Subnav } from '../components/layout/Subnav';
import { PanoPostList, type PanoPostData } from '../components/pano/index';

const FILTERS = [
  { id: 'sicak',    label: 'sıcak' },
  { id: 'yeni',     label: 'yeni' },
  { id: 'en-iyi',   label: 'en iyi' },
  { id: 'tartisma', label: 'tartışma' },
];

export function PanoFeed({ posts }: { posts: PanoPostData[] }) {
  const [filter, setFilter] = React.useState('sicak');
  return (
    <>
      <Subnav
        filters={FILTERS}
        activeFilter={filter}
        onFilterChange={setFilter}
        meta={`${posts.length} başlık`}
      />
      <div className="kp-page">
        <div className="kp-page__inner">
          <PanoPostList posts={posts} />
        </div>
      </div>
    </>
  );
}
