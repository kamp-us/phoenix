import * as React from 'react';
import { graphql, useLazyLoadQuery, useMutation } from 'react-relay';
import { Link, useNavigate, useParams } from 'react-router';
import type { PanoPostDetailCommentsQuery } from '../__generated__/PanoPostDetailCommentsQuery.graphql';
import type { PanoPostDetailDeletePostMutation } from '../__generated__/PanoPostDetailDeletePostMutation.graphql';
import type { PanoPostDetailEditPostMutation } from '../__generated__/PanoPostDetailEditPostMutation.graphql';
import type { PanoPostDetailPostQuery } from '../__generated__/PanoPostDetailPostQuery.graphql';
import { useSession } from '../auth/client';
import { PanoCommentTree, PostVoteWidget, type CommentData } from '../components/pano/index';
import { Tag, type TagKind } from '../components/ui/atoms';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
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
      authorId
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

/**
 * Edit mutation for posts (task_9). Returns the updated title/body so Relay
 * can write the changes into the store keyed by `id` without a refetch.
 */
const EditPostMutation = graphql`
  mutation PanoPostDetailEditPostMutation(
    $id: ID!
    $title: String
    $body: String
  ) {
    editPost(id: $id, title: $title, body: $body) {
      id
      title
      body
    }
  }
`;

/**
 * Delete (hard-from-feed) mutation for posts (task_9). Returns the deleted
 * id; the SPA navigates back to /pano after success so the now-missing post
 * doesn't 404 in front of the user.
 */
const DeletePostMutation = graphql`
  mutation PanoPostDetailDeletePostMutation($id: ID!) {
    deletePost(id: $id)
  }
`;

const TITLE_MAX = 200;
const BODY_MAX = 10_000;

export function PanoPostDetail() {
  const { id } = useParams<{ id: string }>();
  const safeId = id ?? '';
  /* Bumped after a successful edit so the post-page query re-fetches; the
     edit mutation only returns `id/title/body`, so re-fetching keeps the
     other surfaced fields (score, comment count) in sync if they shifted
     between mount and edit submit. */
  const [fetchKey, setFetchKey] = React.useState(0);

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
          <PostContent
            idOrSlug={safeId}
            fetchKey={fetchKey}
            onMutated={() => setFetchKey((k) => k + 1)}
          />
        </QueryBoundary>
      </div>
    </div>
  );
}

function PostContent({
  idOrSlug,
  fetchKey,
  onMutated,
}: {
  idOrSlug: string;
  fetchKey: number;
  onMutated: () => void;
}) {
  const data = useLazyLoadQuery<PanoPostDetailPostQuery>(
    PostQuery,
    {idOrSlug},
    {fetchKey, fetchPolicy: fetchKey === 0 ? 'store-or-network' : 'network-only'},
  );
  const post = data.post;
  const session = useSession();
  const navigate = useNavigate();

  const [editing, setEditing] = React.useState(false);
  const [editTitle, setEditTitle] = React.useState('');
  const [editBody, setEditBody] = React.useState('');
  const [editError, setEditError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const [editCommit, editInFlight] =
    useMutation<PanoPostDetailEditPostMutation>(EditPostMutation);
  const [deleteCommit, deleteInFlight] =
    useMutation<PanoPostDetailDeletePostMutation>(DeletePostMutation);

  if (!post) {
    return (
      <p style={{font: 'var(--t-body)', color: 'var(--text-muted)'}}>
        "{idOrSlug}" başlığı bulunamadı. <Link to="/pano">akışa dön</Link>
      </p>
    );
  }

  const isAuthor = !!session.data?.user && session.data.user.id === post.authorId;

  function onEditClick() {
    if (!post) return;
    setEditTitle(post.title);
    setEditBody(post.body ?? '');
    setEditError(null);
    setEditing(true);
  }

  function onEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!post) return;
    const trimmedTitle = editTitle.trim();
    if (trimmedTitle.length === 0) {
      setEditError('başlık boş olamaz');
      return;
    }
    if (trimmedTitle.length > TITLE_MAX) {
      setEditError(`başlık en fazla ${TITLE_MAX} karakter olabilir`);
      return;
    }
    if (editBody.length > BODY_MAX) {
      setEditError(`metin en fazla ${BODY_MAX} karakter olabilir`);
      return;
    }
    setEditError(null);
    editCommit({
      variables: {
        id: post.id,
        title: trimmedTitle,
        // Empty body submits as empty string; the backend treats that as
        // clearing the body to null.
        body: editBody,
      },
      onCompleted: (_data, errors) => {
        if (errors && errors.length > 0) {
          setEditError(errors[0]?.message ?? 'başlık güncellenemedi');
          return;
        }
        setEditing(false);
        onMutated();
      },
      onError: (err) => setEditError(err.message),
    });
  }

  function onDeleteConfirm() {
    if (!post) return;
    setDeleteError(null);
    deleteCommit({
      variables: {id: post.id},
      onCompleted: (_data, errors) => {
        if (errors && errors.length > 0) {
          setDeleteError(errors[0]?.message ?? 'başlık silinemedi');
          return;
        }
        setConfirmDelete(false);
        navigate('/pano');
      },
      onError: (err) => setDeleteError(err.message),
    });
  }

  return (
    <>
      <header className="kp-pano-postpage__head">
        <PostVoteWidget
          postId={post.id}
          score={post.score}
          myVote={post.myVote ?? null}
        />
        <div>
          {editing ? (
            <form className="kp-pano-edit-post" onSubmit={onEditSubmit}>
              <input
                className="kp-pano-edit-post__title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                disabled={editInFlight}
                data-testid="post-edit-title"
                maxLength={TITLE_MAX + 50}
              />
              <textarea
                className="kp-pano-edit-post__body"
                value={editBody}
                onChange={(e) => setEditBody(e.target.value)}
                disabled={editInFlight}
                data-testid="post-edit-body"
                maxLength={BODY_MAX + 100}
              />
              {editError ? (
                <p
                  className="kp-pano-edit-post__error"
                  role="alert"
                  data-testid="post-edit-error"
                  style={{color: 'var(--danger)', font: 'var(--t-meta)'}}
                >
                  {editError}
                </p>
              ) : null}
              <div style={{display: 'flex', gap: 6}}>
                <Button
                  variant="tertiary"
                  size="sm"
                  type="button"
                  disabled={editInFlight}
                  onClick={() => {
                    setEditing(false);
                    setEditError(null);
                  }}
                >
                  iptal
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  type="submit"
                  disabled={editInFlight || editTitle.trim().length === 0}
                  data-testid="post-edit-save"
                >
                  {editInFlight ? 'kaydediliyor…' : 'kaydet'}
                </Button>
              </div>
            </form>
          ) : (
            <>
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
                {isAuthor ? (
                  <>
                    <button
                      type="button"
                      data-testid="post-edit"
                      onClick={onEditClick}
                    >
                      düzenle
                    </button>
                    <button
                      type="button"
                      data-testid="post-delete"
                      onClick={() => setConfirmDelete(true)}
                    >
                      sil
                    </button>
                  </>
                ) : null}
              </div>
              {post.body ? (
                <div className="kp-pano-postpage__body">
                  {post.body
                    .split(/\n{2,}/)
                    .map((para, i) => <p key={i}>{renderMarkdownInline(para)}</p>)}
                </div>
              ) : null}
            </>
          )}
        </div>
      </header>

      {isAuthor ? (
        <Dialog.Root open={confirmDelete} onOpenChange={setConfirmDelete}>
          <Dialog.Popup>
            <Dialog.Head
              title="başlığı sil"
              description="bu başlığı silmek istediğine emin misin? geri alınamaz."
            />
            <Dialog.Body>
              {deleteError ? (
                <p
                  role="alert"
                  style={{color: 'var(--danger)', font: 'var(--t-meta)'}}
                >
                  {deleteError}
                </p>
              ) : null}
            </Dialog.Body>
            <Dialog.Foot>
              <Dialog.Close render={<Button variant="tertiary">vazgeç</Button>} />
              <Button
                variant="primary"
                type="button"
                disabled={deleteInFlight}
                data-testid="post-delete-confirm"
                onClick={onDeleteConfirm}
              >
                {deleteInFlight ? 'siliniyor…' : 'sil'}
              </Button>
            </Dialog.Foot>
          </Dialog.Popup>
        </Dialog.Root>
      ) : null}

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
