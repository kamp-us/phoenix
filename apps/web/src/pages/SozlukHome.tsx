import * as React from 'react';
import {
  SozlukAlphabet,
  SozlukPopular,
  SozlukTermList,
  type PopularTerm,
  type TermRow,
} from '../components/sozluk/index';
import './SozlukHome.css';

export function SozlukHome({
  recent,
  popular,
  totals,
}: {
  recent: TermRow[];
  popular: PopularTerm[];
  totals?: { terms: number; definitions: number; newToday: number };
}) {
  const [letter, setLetter] = React.useState<string | undefined>();
  const [query, setQuery] = React.useState('');

  const filtered = recent.filter((t) => {
    if (letter && !t.title.toLowerCase().startsWith(letter)) return false;
    if (query && !t.title.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  const t = totals ?? {
    terms: 1847,
    definitions: 6213,
    newToday: 23,
  };

  return (
    <div className="kp-page">
      <div className="kp-page__inner">
        <header className="kp-sozluk-home__masthead">
          <div>
            <h1 className="kp-sozluk-home__title">
              sözlük{' '}
              <small>
                {t.terms.toLocaleString('tr-TR')} terim ·{' '}
                {t.definitions.toLocaleString('tr-TR')} tanım · son 24 sa: {t.newToday} yeni
              </small>
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
