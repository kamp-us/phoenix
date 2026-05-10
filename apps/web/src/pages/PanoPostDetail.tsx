import {Link} from 'react-router';
import {
  PanoCommentTree,
  VoteControl,
  type CommentData,
  type PanoPostData,
} from '../components/pano/index';
import { Tag } from '../components/ui/atoms';
import { Button } from '../components/ui/Button';
import './PanoPostDetail.css';

export function PanoPostDetail({
  post,
  comments,
}: {
  post: PanoPostData;
  comments: CommentData[];
}) {
  return (
    <div className="kp-page">
      <div className="kp-page__inner">
        <Link to="/pano" className="kp-pano-postpage__back">
          ← akışa dön
        </Link>
        <header className="kp-pano-postpage__head">
          <VoteControl count={post.score} myVote={post.myVote} />
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
              {post.tags?.map((t, i) => (
                <Tag key={i} kind={t.kind}>
                  {t.label}
                </Tag>
              ))}
              <span className="author">@{post.author}</span>
              <span>·</span>
              <span>{post.agoLabel}</span>
              <span>·</span>
              <span>{post.commentCount} yorum</span>
              <span>·</span>
              <button type="button">paylaş</button>
              <button type="button">kaydet</button>
              <button type="button">bildir</button>
            </div>
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

        <h2 className="kp-pano-postpage__thread-heading">{comments.length} yorum</h2>
        <PanoCommentTree comments={comments} />
      </div>
    </div>
  );
}
