import * as React from 'react';
import { graphql, useLazyLoadQuery } from 'react-relay';
import { Link, useParams } from 'react-router';
import type { PanoPostDetailCommentsQuery } from '../__generated__/PanoPostDetailCommentsQuery.graphql';
import type { PanoPostDetailPostQuery } from '../__generated__/PanoPostDetailPostQuery.graphql';
import { PanoCommentTree, PostVoteWidget, type CommentData } from '../components/pano/index';
import { Tag, type TagKind } from '../components/ui/atoms';
import { Button } from '../components/ui/Button';
import { formatAgoTR } from '../lib/datetime';
import { renderMarkdownInline } from '../lib/markdown';
import { QueryBoundary } from '../relay/QueryBoundary';
import './PanoPostDetail.css';

const PostQuery = graphql`
  query PanoPostDetailPostQuery($idOrSlug: String!) {
    post(idOrSlug: $idOrSlug) {
      id
      slug
      title
      url
      host
      body
      author
      score
      commentCount
      createdAt
      tags {
        kind
        label
      }
    }
  }
`;

const CommentsQuery = graphql`
  query PanoPostDetailCommentsQuery($postId: String!) {
    postComments(postId: $postId) {
      id
      parentId
      author
      body
      score
      createdAt
    }
  }
`;

export function PanoPostDetail() {
  const { id } = useParams<{ id: string }>();
  const safeId = id ?? '';

  return (
    <div className="kp-page">
      <div className="kp-page__inner">
        <Link to="/pano" className="kp-pano-postpage__back">
          ← akışa dön
        </Link>
        <QueryBoundary
          loading={
            <p style={{font: 'var(--t-meta)', color: 'var(--text-muted)'}}>yükleniyor…</p>
          }
          error={(err) => (
            <p style={{font: 'var(--t-body)', color: 'var(--danger)'}}>
              başlık yüklenemedi: {err.message}
            </p>
          )}
        >
          <PostContent idOrSlug={safeId} />
        </QueryBoundary>
      </div>
    </div>
  );
}

function PostContent({idOrSlug}: {idOrSlug: string}) {
  const data = useLazyLoadQuery<PanoPostDetailPostQuery>(PostQuery, {idOrSlug});
  const post = data.post;

  if (!post) {
    return (
      <p style={{font: 'var(--t-body)', color: 'var(--text-muted)'}}>
        "{idOrSlug}" başlığı bulunamadı. <Link to="/pano">akışa dön</Link>
      </p>
    );
  }

  return (
    <>
      <header className="kp-pano-postpage__head">
        <PostVoteWidget postId={post.id} baseScore={post.score} />
        <div>
          <h1 className="kp-pano-postpage__title">{post.title}</h1>
          {post.url ? (
            <a
              className="kp-pano-postpage__url"
              href={post.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {post.host ?? post.url} ↗
            </a>
          ) : null}
          <div className="kp-pano-postpage__meta">
            {post.tags.map((t, i) => (
              <Tag key={i} kind={t.kind as TagKind}>
                {t.label}
              </Tag>
            ))}
            <span className="author">@{post.author}</span>
            <span>·</span>
            <span>{formatAgoTR(post.createdAt)}</span>
            <span>·</span>
            <span>{post.commentCount} yorum</span>
            <span>·</span>
            <button type="button">paylaş</button>
            <button type="button">kaydet</button>
            <button type="button">bildir</button>
          </div>
          {post.body ? (
            <div className="kp-pano-postpage__body">
              {post.body
                .split(/\n{2,}/)
                .map((para, i) => <p key={i}>{renderMarkdownInline(para)}</p>)}
            </div>
          ) : null}
        </div>
      </header>

      <form
        className="kp-pano-comment-composer"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <textarea
          className="kp-pano-comment-composer__textarea"
          placeholder="yorum yaz. markdown çalışır, ``` ``` kod bloğu çalışır."
        />
        <div className="kp-pano-comment-composer__foot">
          <span className="kp-pano-comment-composer__hint">
            markdown · <kbd>⌘</kbd>+<kbd>↵</kbd>
          </span>
          <Button variant="primary" size="sm" type="submit">
            yorum ekle
          </Button>
        </div>
      </form>

      <Comments postId={post.id} />
    </>
  );
}

/**
 * Separate query so the post-page header renders before the thread does;
 * also lets the comment list cache and stream on its own cadence later.
 */
function Comments({postId}: {postId: string}) {
  const data = useLazyLoadQuery<PanoPostDetailCommentsQuery>(CommentsQuery, {postId});
  const tree = React.useMemo(() => buildTree(data.postComments), [data.postComments]);

  return (
    <>
      <h2 className="kp-pano-postpage__thread-heading">{data.postComments.length} yorum</h2>
      <PanoCommentTree comments={tree} />
    </>
  );
}

type FlatComment = PanoPostDetailCommentsQuery['response']['postComments'][number];

/**
 * Walk the flat list and build the tree by `parentId`. Top-level entries
 * are those with `parentId === null`; descendants attach under their parent's
 * `children`. The DO already orders by `desc(score), asc(createdAt)`, so
 * we preserve insertion order at each level — no extra sort here.
 */
function buildTree(rows: ReadonlyArray<FlatComment>): CommentData[] {
  const byId = new Map<string, CommentData>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      author: r.author,
      agoLabel: formatAgoTR(r.createdAt),
      score: r.score,
      body: <CommentBody text={r.body} />,
    });
  }
  const roots: CommentData[] = [];
  for (const r of rows) {
    const node = byId.get(r.id);
    if (!node) continue;
    if (r.parentId) {
      const parent = byId.get(r.parentId);
      if (parent) {
        if (!parent.children) parent.children = [];
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }
  return roots;
}

/** Inline-markdown rendering for comment bodies — same shape as the sözlük
    DefinitionCard's `Body`, factored to lib/markdown for reuse. */
function CommentBody({text}: {text: string}) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <>
      {paragraphs.map((para, i) => (
        <p key={i}>{renderMarkdownInline(para)}</p>
      ))}
    </>
  );
}
