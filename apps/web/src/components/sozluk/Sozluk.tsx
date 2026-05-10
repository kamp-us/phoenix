import * as React from 'react';
import { ToggleGroup } from '../ui/ToggleGroup';
import './Sozluk.css';

export type TermRow = { slug: string; title: string; count: number };

export function SozlukTermRow({ term }: { term: TermRow }) {
  return (
    <div className="kp-sozluk-term">
      <h3 className="kp-sozluk-term__title">
        <a href={`/sozluk/${term.slug}`}>{term.title}</a>
      </h3>
      <span className="kp-sozluk-term__count">{term.count}</span>
    </div>
  );
}

export function SozlukTermList({ terms }: { terms: TermRow[] }) {
  return (
    <div className="kp-sozluk-list">
      {terms.map((t) => <SozlukTermRow key={t.slug} term={t} />)}
    </div>
  );
}

export type DefinitionData = {
  id: string;
  body: React.ReactNode;
  author: string;
  agoLabel: string;
  score: number;
};

export function SozlukDefinition({ d }: { d: DefinitionData }) {
  return (
    <article className="kp-definition" id={d.id}>
      <div className="kp-definition__body">{d.body}</div>
      <div className="kp-definition__meta">
        <a href={`/u/${d.author}`}>@{d.author}</a>
        <span>·</span>
        <span>{d.agoLabel}</span>
        <span>·</span>
        <span>{d.score} puan</span>
      </div>
    </article>
  );
}

export function SozlukDefinitionList({ defs }: { defs: DefinitionData[] }) {
  return (
    <div className="kp-sozluk-list">
      {defs.map((d) => <SozlukDefinition key={d.id} d={d} />)}
    </div>
  );
}

const ALPHABET = ['a','b','c','ç','d','e','f','g','ğ','h','ı','i','j','k','l','m','n','o','ö','p','r','s','ş','t','u','ü','v','y','z'];

export function SozlukAlphabet({
  value,
  emptyLetters = [],
  onChange,
}: {
  value?: string;
  emptyLetters?: string[];
  onChange?: (l: string) => void;
}) {
  return (
    <ToggleGroup.Root
      variant="square"
      className="kp-alphabet"
      value={value ? [value] : []}
      onValueChange={(v) => v[0] && onChange?.(v[0])}
      aria-label="Harf"
    >
      {ALPHABET.map((l) => (
        <ToggleGroup.Item
          key={l}
          value={l}
          disabled={emptyLetters.includes(l)}
        >
          {l.toUpperCase()}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
