import * as React from 'react';
import { PanoPostList, type PanoPostData } from '../components/pano/index';
import { Subnav } from '../components/layout/Subnav';
import { ToggleGroup } from '../components/ui/ToggleGroup';
const FILTERS = [
  { id: 'sicak',     label: 'sıcak' },
  { id: 'yeni',      label: 'yeni' },
  { id: 'en-iyi',    label: 'en iyi' },
  { id: 'tartisma',  label: 'tartışma' },
];

export function PanoFeed({ posts }: { posts: PanoPostData[] }) {
  const [filter, setFilter] = React.useState('sicak');
  return (
    <>
      <Subnav
        title="pano"
        count={`${posts.length} başlık`}
        filters={
          <ToggleGroup.Root
            value={[filter]}
            onValueChange={(v) => v[0] && setFilter(v[0])}
            aria-label="Sıralama"
          >
            {FILTERS.map((f) => (
              <ToggleGroup.Item key={f.id} value={f.id}>{f.label}</ToggleGroup.Item>
            ))}
          </ToggleGroup.Root>
        }
      />
      <PanoPostList posts={posts} />
    </>
  );
}
