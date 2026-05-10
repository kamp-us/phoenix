import * as React from 'react';
import { graphql, useLazyLoadQuery, useMutation } from 'react-relay';
import { Link, useNavigate, useParams } from 'react-router';
import type { PanoPostDetailAddCommentMutation } from '../__generated__/PanoPostDetailAddCommentMutation.graphql';
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

/**
 * Add comment mutation (task_10). Returns the new comment so Relay can write
 * it into the store; we follow up with a CommentsQuery refetch via fetchKey
 * to land the new row in the tree (the GraphQL query is its own page-level
 * Relay query, not a connection).
 */
const AddCommentMutation = graphql`
  mutation PanoPostDetailAddCommentMutation(
    $postId: ID!
    $parentId: ID
    $body: String!
  ) {
    addComment(postId: $postId, parentId: $parentId, body: $body) {
      id
      parentId
      author
      body
      score
      createdAt
    }
  }
`;

const COMMENT_BODY_MAX = 5_000;

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

      <React.Suspense
        fallback={
          <p style={{font: 'var(--t-meta)', color: 'var(--text-muted)'}}>
            yorumlar yükleniyor…
          </p>
        }
      >
        <Comments postId={post.id} signedIn={!!session.data?.user} />
      </React.Suspense>
    </>
  );
}

/**
 * Inline comment composer (task_10). When `parentId` is null this is the
 * top-level "yorum ekle" form rendered at the top of the thread; when set
 * it's the per-comment reply form nested under a `PanoComment`. Submits to
 * the `addComment` mutation; on success calls `onAdded` to refetch the
 * comments query (parent owns the fetchKey).
 *
 * Signed-out users see the composer disabled with a sign-in prompt; clicking
 * the button routes to `/auth?returnTo=<current-url>` per the rest of the
 * auth-gated mutations (T4/T5/T7/T8).
 */
function CommentComposer({
  postId,
  parentId,
  signedIn,
  onAdded,
  onCancel,
  autoFocus,
}: {
  postId: string;
  parentId: string | null;
  signedIn: boolean;
  onAdded: () => void;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [commit, inFlight] = useMutation<PanoPostDetailAddCommentMutation>(AddCommentMutation);
  const navigate = useNavigate();
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!signedIn) {
      navigate(`/auth?returnTo=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      setError('yorum boş olamaz');
      return;
    }
    if (body.length > COMMENT_BODY_MAX) {
      setError(`yorum en fazla ${COMMENT_BODY_MAX} karakter olabilir`);
      return;
    }
    setError(null);
    commit({
      variables: {
        postId,
        parentId: parentId ?? null,
        body,
      },
      onCompleted: (_data, errors) => {
        if (errors && errors.length > 0) {
          setError(errors[0]?.message ?? 'yorum eklenemedi');
          return;
        }
        setBody('');
        onAdded();
        onCancel?.();
      },
      onError: (err) => setError(err.message),
    });
  }

  const testId = parentId
    ? `pano-comment-reply-${parentId}`
    : 'pano-comment-composer';

  return (
    <form
      className="kp-pano-comment-composer"
      onSubmit={submit}
      data-testid={testId}
    >
      <textarea
        ref={textareaRef}
        className="kp-pano-comment-composer__textarea"
        placeholder={
          signedIn
            ? 'yorum yaz. markdown çalışır, ``` ``` kod bloğu çalışır.'
            : 'yorum yazmak için giriş yap'
        }
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={inFlight || !signedIn}
        data-testid={parentId ? `pano-comment-reply-input-${parentId}` : 'pano-comment-input'}
        maxLength={COMMENT_BODY_MAX + 100}
      />
      {error ? (
        <p
          role="alert"
          data-testid="pano-comment-error"
          style={{color: 'var(--danger)', font: 'var(--t-meta)'}}
        >
          {error}
        </p>
      ) : null}
      <div className="kp-pano-comment-composer__foot">
        <span className="kp-pano-comment-composer__hint">
          markdown · <kbd>⌘</kbd>+<kbd>↵</kbd>
        </span>
        <div style={{display: 'flex', gap: 6}}>
          {onCancel ? (
            <Button
              variant="tertiary"
              size="sm"
              type="button"
              onClick={onCancel}
              disabled={inFlight}
            >
              iptal
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            type="submit"
            disabled={inFlight || body.trim().length === 0}
            data-testid={parentId ? `pano-comment-reply-submit-${parentId}` : 'pano-comment-submit'}
          >
            {inFlight ? 'gönderiliyor…' : parentId ? 'yanıtla' : 'yorum ekle'}
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * Separate query so the post-page header renders before the thread does;
 * also lets the comment list cache and stream on its own cadence later.
 *
 * After an `addComment` mutation we bump `fetchKey` so this query refetches
 * with `network-only` and the new comment (top-level or nested) lands in the
 * tree. Mirrors the invalidate-on-mutate pattern from `SozlukTermPage` (T4)
 * and the post detail's own edit refetch.
 */
function Comments({postId, signedIn}: {postId: string; signedIn: boolean}) {
  const [fetchKey, setFetchKey] = React.useState(0);
  const data = useLazyLoadQuery<PanoPostDetailCommentsQuery>(
    CommentsQuery,
    {postId},
    {fetchKey, fetchPolicy: fetchKey === 0 ? 'store-or-network' : 'network-only'},
  );
  const [replyTo, setReplyTo] = React.useState<string | null>(null);
  const onAdded = React.useCallback(() => setFetchKey((k) => k + 1), []);
  const tree = React.useMemo(
    () =>
      buildTree(data.postComments, {
        replyTo,
        onReply: setReplyTo,
        onCancelReply: () => setReplyTo(null),
        onAdded,
        postId,
        signedIn,
      }),
    [data.postComments, replyTo, onAdded, postId, signedIn],
  );

  return (
    <>
      <CommentComposer
        postId={postId}
        parentId={null}
        signedIn={signedIn}
        onAdded={onAdded}
      />
      <h2 className="kp-pano-postpage__thread-heading">{data.postComments.length} yorum</h2>
      <PanoCommentTree
        comments={tree}
        onReply={(id) => setReplyTo(id)}
      />
    </>
  );
}

type FlatComment = PanoPostDetailCommentsQuery['response']['postComments'][number];

interface ReplyHandlers {
  replyTo: string | null;
  onReply: (id: string) => void;
  onCancelReply: () => void;
  onAdded: () => void;
  postId: string;
  signedIn: boolean;
}

/**
 * Walk the flat list and build the tree by `parentId`. Top-level entries
 * are those with `parentId === null`; descendants attach under their parent's
 * `children`. The DO already orders by `desc(score), asc(createdAt)`, so
 * we preserve insertion order at each level — no extra sort here.
 *
 * When `replyTo` matches a comment id, that comment carries an inline
 * `replyComposer` so the user can post a nested reply without modal/route
 * dance. The composer's `onAdded` bumps the comments fetchKey on the parent.
 */
function buildTree(
  rows: ReadonlyArray<FlatComment>,
  handlers: ReplyHandlers,
): CommentData[] {
  const byId = new Map<string, CommentData>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      author: r.author,
      agoLabel: formatAgoTR(r.createdAt),
      score: r.score,
      body: <CommentBody text={r.body} />,
      replyComposer:
        handlers.replyTo === r.id ? (
          <CommentComposer
            postId={handlers.postId}
            parentId={r.id}
            signedIn={handlers.signedIn}
            onAdded={handlers.onAdded}
            onCancel={handlers.onCancelReply}
            autoFocus
          />
        ) : undefined,
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
