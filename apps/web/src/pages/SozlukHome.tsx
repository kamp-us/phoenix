import * as React from 'react';
import { useGraphQL } from '../graphql/useGraphQL';
import {
  SozlukAlphabet,
  SozlukPopular,
  SozlukTermList,
  type PopularTerm,
  type TermRow,
} from '../components/sozluk/index';
import './SozlukHome.css';

const RECENT_QUERY = `
  query SozlukRecent {
    terms(sort: recent, limit: 24) {
      id
      slug
      title
      count
      excerpt
      totalScore
    }
  }
`;

const POPULAR_QUERY = `
  query SozlukPopular {
    terms(sort: popular, limit: 10) {
      id
      slug
      title
      totalScore
    }
  }
`;

export function SozlukHome() {
  const [letter, setLetter] = React.useState<string | undefined>();
  const [query, setQuery] = React.useState('');

  const recentR = useGraphQL<{terms: TermRow[]}>(RECENT_QUERY);
  const popularR = useGraphQL<{terms: PopularTerm[]}>(POPULAR_QUERY);

  const recent = recentR.kind === 'ok' ? recentR.data.terms : [];
  const popular = popularR.kind === 'ok' ? popularR.data.terms : [];

  const filtered = recent.filter((t) => {
    if (letter && !t.title.toLowerCase().startsWith(letter)) return false;
    if (query && !t.title.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const totalsLine =
    recentR.kind === 'ok'
      ? `${recent.length} terim · son 24 sa: ${recent.length} yeni`
      : recentR.kind === 'loading'
      ? 'yükleniyor…'
      : 'yüklenemedi';

  return (
    <div className="kp-page">
      <div className="kp-page__inner">
        <header className="kp-sozluk-home__masthead">
          <div>
            <h1 className="kp-sozluk-home__title">
              sözlük <small>{totalsLine}</small>
            </h1>
          </div>
          <label className="kp-sozluk-home__searchbar">
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="terim ara: race condition, idempotent…"
              aria-label="Terim ara"
            />
          </label>
        </header>

        <SozlukAlphabet value={letter} onChange={setLetter} />

        {recentR.kind === 'error' ? (
          <p style={{font: 'var(--t-meta)', color: 'var(--danger)', padding: 'var(--s-3) 0'}}>
            sözlük yüklenemedi: {recentR.message}
          </p>
        ) : null}

        <div className="kp-sozluk-home__columns">
          <section>
            <header className="kp-sozluk-home__col-head">
              <span className="title">son eklenenler</span>
              <span>24 sa</span>
            </header>
            <SozlukTermList terms={filtered} />
          </section>

          <section>
            <header className="kp-sozluk-home__col-head">
              <span className="title">en çok oylananlar</span>
              <span>tüm zamanlar</span>
            </header>
            <SozlukPopular terms={popular} />
          </section>
        </div>
      </div>
    </div>
  );
}
