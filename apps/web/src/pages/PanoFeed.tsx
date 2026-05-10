import * as React from 'react';
import { graphql, useLazyLoadQuery } from 'react-relay';
import type { PanoFeedQuery, PostSort } from '../__generated__/PanoFeedQuery.graphql';
import { Subnav } from '../components/layout/Subnav';
import { PanoCrumb, PanoPostList } from '../components/pano/index';
import type { PanoPostData } from '../components/pano/index';
import type { TagKind } from '../components/ui';
import { formatAgoTR } from '../lib/datetime';
import { QueryBoundary } from '../relay/QueryBoundary';

const FeedQuery = graphql`
  query PanoFeedQuery($sort: PostSort, $host: String) {
    posts(sort: $sort, limit: 50, host: $host) {
      id
      slug
      title
      url
      host
      author
      score
      commentCount
      createdAt
      myVote
      tags {
        kind
        label
      }
    }
  }
`;

/**
 * UI sort labels (Turkish) → server `PostSort` enum. The "tartışma" filter
 * is a client-side discuss-tag filter today; once the API grows tag filtering
 * it migrates to the `posts(...)` argument list.
 *
 * TODO: server-side tag filter — push the discuss-tag filter into the DO so
 *       `tartışma` is a real query, not a client-side narrow.
 */
const FILTERS = [
  { id: 'sicak',    label: 'sıcak',    sort: 'hot' as const },
  { id: 'yeni',     label: 'yeni',     sort: 'new' as const },
  { id: 'en-iyi',   label: 'en iyi',   sort: 'top' as const },
  { id: 'tartisma', label: 'tartışma', sort: 'hot' as const, tagKind: 'discuss' },
];

export function PanoFeed({ host }: { host?: string }) {
  const [filterId, setFilterId] = React.useState('sicak');
  const filter = FILTERS.find((f) => f.id === filterId) ?? FILTERS[0];
  if (!filter) return null;

  return (
    <QueryBoundary
      loading={
        <FeedChrome
          host={host}
          filterId={filterId}
          setFilterId={setFilterId}
          status="loading"
          posts={[]}
        />
      }
      error={(err) => (
        <FeedChrome
          host={host}
          filterId={filterId}
          setFilterId={setFilterId}
          status="error"
          errorMessage={err.message}
          posts={[]}
        />
      )}
    >
      <FeedContent
        host={host}
        filterId={filterId}
        setFilterId={setFilterId}
        sort={filter.sort}
        tagKind={filter.tagKind}
      />
    </QueryBoundary>
  );
}

function FeedContent({
  host,
  filterId,
  setFilterId,
  sort,
  tagKind,
}: {
  host?: string;
  filterId: string;
  setFilterId: (id: string) => void;
  sort: PostSort;
  tagKind?: string;
}) {
  const data = useLazyLoadQuery<PanoFeedQuery>(FeedQuery, {
    sort,
    host: host ?? null,
  });

  const posts = tagKind
    ? data.posts.filter((p) => p.tags.some((t) => t.kind === tagKind))
    : data.posts;

  return (
    <FeedChrome
      host={host}
      filterId={filterId}
      setFilterId={setFilterId}
      status="ok"
      posts={posts.map(toPostData)}
    />
  );
}

interface ChromeProps {
  host?: string;
  filterId: string;
  setFilterId: (id: string) => void;
  status: 'loading' | 'ok' | 'error';
  errorMessage?: string;
  posts: PanoPostData[];
}

function FeedChrome({
  host,
  filterId,
  setFilterId,
  status,
  errorMessage,
  posts,
}: ChromeProps) {
  const meta =
    status === 'loading'
      ? 'yükleniyor…'
      : host
      ? `${posts.length} başlık · ${host}`
      : `${posts.length} başlık`;

  return (
    <>
      <Subnav
        filters={FILTERS}
        activeFilter={filterId}
        onFilterChange={setFilterId}
        meta={meta}
      />
      {host ? <PanoCrumb host={host} /> : null}
      <div className="kp-page">
        <div className="kp-page__inner">
          {status === 'error' ? (
            <p style={{font: 'var(--t-meta)', color: 'var(--danger)'}}>
              başlıklar yüklenemedi: {errorMessage}
            </p>
          ) : (
            <PanoPostList posts={posts} />
          )}
        </div>
      </div>
    </>
  );
}

type FeedPost = PanoFeedQuery['response']['posts'][number];

/** Adapt the GraphQL row to the existing presentational shape. Display-only
    derivations (rank, agoLabel) live here, not on the server. */
function toPostData(p: FeedPost, i: number): PanoPostData {
  const data: PanoPostData = {
    id: p.id,
    rank: i + 1,
    title: p.title,
    href: `/pano/${p.slug ?? p.id}`,
    author: p.author,
    agoLabel: formatAgoTR(p.createdAt),
    commentCount: p.commentCount,
    score: p.score,
    myVote: p.myVote === 1 ? 1 : 0,
    tags: p.tags.map((t) => ({kind: t.kind as TagKind, label: t.label})),
  };
  if (p.url) data.url = p.url;
  if (p.host) data.host = p.host;
  return data;
}
