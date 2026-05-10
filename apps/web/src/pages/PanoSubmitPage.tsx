import * as React from 'react';
import { Link } from 'react-router';
import { Button } from '../components/ui/Button';
import { type TagKind } from '../components/ui/atoms';
import './PanoSubmitPage.css';

type Mode = 'link' | 'text';

const TAGS: { kind: TagKind; label: string }[] = [
  { kind: 'discuss', label: 'tartışma' },
  { kind: 'ask',     label: 'soru' },
  { kind: 'show',    label: 'göster' },
  { kind: 'rant',    label: 'söylenme' },
  { kind: 'news',    label: 'haber' },
  { kind: 'meta',    label: 'react' },
  { kind: 'meta',    label: 'js' },
  { kind: 'meta',    label: 'ts' },
];

const URL_RE = /^https?:\/\/[^/]+/i;

function hostOf(url: string) {
  const m = URL_RE.exec(url);
  return m ? m[0].replace(/^https?:\/\//, '') : '';
}

export function PanoSubmitPage() {
  const [mode, setMode] = React.useState<Mode>('link');
  const [url, setUrl] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');
  const [selectedTags, setSelectedTags] = React.useState<Set<string>>(new Set());

  const host = hostOf(url);
  const showPreview = mode === 'link' && host.length > 0;

  function toggleTag(label: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else if (next.size < 3) next.add(label);
      return next;
    });
  }

  return (
    <div className="kp-page">
      <div className="kp-page__inner">
        <div className="kp-pano-submit">
          <Link to="/pano" className="kp-pano-submit__back">
            ← akışa dön
          </Link>
          <h1 className="kp-pano-submit__title">Bir şey paylaş</h1>
          <p className="kp-pano-submit__lede">
            Bağlantı, yazı, soru. Self-promo da olur — bir kere açıkla niye paylaşıyorsun.
          </p>

          <div className="kp-pano-submit__toggle">
            <button
              type="button"
              aria-pressed={mode === 'link'}
              onClick={() => setMode('link')}
            >
              link
            </button>
            <button
              type="button"
              aria-pressed={mode === 'text'}
              onClick={() => setMode('text')}
            >
              yazı
            </button>
          </div>

          <form
            className="kp-pano-submit__form"
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            {mode === 'link' ? (
              <>
                <div className="kp-pano-submit__field">
                  <label htmlFor="submit-url">URL</label>
                  <input
                    id="submit-url"
                    type="url"
                    placeholder="https://overreacted.io/..."
                    value={url}
                    onChange={(e) => setUrl(e.currentTarget.value)}
                  />
                </div>
                {showPreview ? (
                  <div className="kp-pano-submit__url-preview">
                    <div className="fav">{host.charAt(0).toLowerCase()}</div>
                    <div>
                      <div className="host">{host}</div>
                      <div className="ttl">{title || 'başlık otomatik tamamlanacak'}</div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            <div className="kp-pano-submit__field">
              <label htmlFor="submit-title">başlık</label>
              <input
                id="submit-title"
                type="text"
                minLength={5}
                placeholder="en az 5 karakter"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
              <span className="kp-pano-submit__hint">
                {title.length < 5 ? '5 karakterden az olamaz · ' : ''}
                {title.length}/300
              </span>
            </div>

            {mode === 'link' ? (
              <div className="kp-pano-submit__field">
                <label htmlFor="submit-context">bağlam (opsiyonel)</label>
                <textarea
                  id="submit-context"
                  placeholder="bir kere açıkla niye paylaşıyorsun"
                  value={body}
                  onChange={(e) => setBody(e.currentTarget.value)}
                />
              </div>
            ) : (
              <div className="kp-pano-submit__field">
                <label htmlFor="submit-body">
                  içerik{' '}
                  <span style={{color: 'var(--text-faint)', fontWeight: 400}}>(opsiyonel)</span>
                </label>
                <textarea
                  id="submit-body"
                  style={{minHeight: 220}}
                  placeholder="markdown · ``` ``` kod bloğu"
                  value={body}
                  onChange={(e) => setBody(e.currentTarget.value)}
                />
                <span className="kp-pano-submit__hint">
                  markdown · ``` ``` kod bloğu · {body.length}/40000
                </span>
              </div>
            )}

            <div className="kp-pano-submit__field">
              <label>etiketler · en fazla 3</label>
              <div className="kp-pano-submit__tagrow">
                {TAGS.map((t) => {
                  const on = selectedTags.has(t.label);
                  return (
                    <button
                      key={t.label}
                      type="button"
                      className={`kp-tag kp-tag--${t.kind} ${on ? 'is-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => toggleTag(t.label)}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="kp-pano-submit__form-actions">
              <Button type="button" variant="tertiary">
                taslak
              </Button>
              <Button type="submit" variant="primary">
                paylaş
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
