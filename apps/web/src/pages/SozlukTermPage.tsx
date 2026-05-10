import * as React from "react";
import {graphql, useLazyLoadQuery, useMutation} from "react-relay";
import {Link, useNavigate, useParams} from "react-router";
import type {SozlukTermPageAddDefinitionMutation} from "../__generated__/SozlukTermPageAddDefinitionMutation.graphql";
import type {SozlukTermPageQuery} from "../__generated__/SozlukTermPageQuery.graphql";
import {useSession} from "../auth/client";
import {Button} from "../components/ui/Button";
import {formatAgoTR, formatDateTR} from "../lib/datetime";
import {renderMarkdownInline, splitMarkdownBlocks} from "../lib/markdown";
import {QueryBoundary} from "../relay/QueryBoundary";
import "./SozlukTermPage.css";

const TermQuery = graphql`
  query SozlukTermPageQuery($slug: String!) {
    term(slug: $slug) {
      id
      slug
      title
      count
      totalScore
      firstAt
      lastEdit
      definitions {
        id
        body
        author
        score
        createdAt
        updatedAt
      }
    }
  }
`;

type TermNode = NonNullable<SozlukTermPageQuery["response"]["term"]>;
type DefinitionNode = TermNode["definitions"][number];

export function SozlukTermPage() {
	const {slug} = useParams<{slug: string}>();
	const safeSlug = slug ?? "";
	/* Bumped on every successful addDefinition mutation; forces useLazyLoadQuery
     to re-fetch so the freshly added definition appears in the list. */
	const [fetchKey, setFetchKey] = React.useState(0);

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<QueryBoundary
					loading={<p style={{font: "var(--t-meta)", color: "var(--text-muted)"}}>yükleniyor…</p>}
					error={(err) => (
						<p style={{font: "var(--t-body)", color: "var(--danger)"}}>
							terim yüklenemedi: {err.message}
						</p>
					)}
				>
					<SozlukTermContent
						slug={safeSlug}
						fetchKey={fetchKey}
						onMutated={() => setFetchKey((k) => k + 1)}
					/>
				</QueryBoundary>
			</div>
		</div>
	);
}

function SozlukTermContent({
	slug,
	fetchKey,
	onMutated,
}: {
	slug: string;
	fetchKey: number;
	onMutated: () => void;
}) {
	const data = useLazyLoadQuery<SozlukTermPageQuery>(
		TermQuery,
		{slug},
		{fetchKey, fetchPolicy: fetchKey === 0 ? "store-or-network" : "network-only"},
	);
	const term = data.term;

	if (!term) {
		/* Slug doesn't exist yet — show the composer so the first definition
       creates both the term and the entry. Same auto-create-term contract
       enforced server-side by SozlukTerm.addDefinition (task_4). */
		return (
			<>
				<header className="kp-sozluk-term__head">
					<p className="kp-sozluk-term__crumbs">
						<Link to="/sozluk">sözlük</Link> /{" "}
						<Link to="/sozluk">{slug.charAt(0).toLowerCase()}</Link> / {slug.replace(/-/g, " ")}
					</p>
					<h1 className="kp-sozluk-term__title">{slug.replace(/-/g, " ")}</h1>
					<div className="kp-sozluk-term__meta">
						<span>henüz tanım yok</span>
					</div>
				</header>
				<p style={{font: "var(--t-body)", color: "var(--text-muted)"}}>
					"{slug}" terimi henüz yok. ilk tanımı sen yazabilirsin.
				</p>
				<Composer slug={slug} onAdded={onMutated} />
			</>
		);
	}

	const firstLetter = term.title.charAt(0).toLowerCase();

	return (
		<>
			<header className="kp-sozluk-term__head">
				<p className="kp-sozluk-term__crumbs">
					<Link to="/sozluk">sözlük</Link> / <Link to="/sozluk">{firstLetter}</Link> / {term.title}
				</p>
				<h1 className="kp-sozluk-term__title">{term.title}</h1>
				<div className="kp-sozluk-term__meta">
					<span>{term.count} tanım</span>
					<span>{term.totalScore} oy</span>
					{term.firstAt ? <span>ilk: {formatDateTR(term.firstAt)}</span> : null}
					{term.lastEdit ? <span>son düzenleme: {formatAgoTR(term.lastEdit)}</span> : null}
				</div>
			</header>

			{term.definitions.map((d, i) => (
				<DefinitionCard key={d.id} definition={d} rank={i + 1} top={i === 0} />
			))}

			<Composer slug={slug} onAdded={onMutated} />
		</>
	);
}

function DefinitionCard({
	definition,
	rank,
	top,
}: {
	definition: DefinitionNode;
	rank: number;
	top: boolean;
}) {
	const [voted, setVoted] = React.useState(false);
	const cls = top ? "kp-sozluk-definition kp-sozluk-definition--top" : "kp-sozluk-definition";

	return (
		<article className={cls}>
			<div className="kp-sozluk-definition__vote">
				<button
					type="button"
					className="kp-sozluk-definition__vote-btn"
					aria-pressed={voted}
					aria-label="Yukarı oy"
					onClick={() => setVoted(!voted)}
				>
					<span className="triangle" />
				</button>
				<span className="kp-sozluk-definition__vote-count">{definition.score}</span>
				<span className="kp-sozluk-definition__rank">#{rank}</span>
			</div>
			<div>
				<Body text={definition.body} />
				<footer className="kp-sozluk-definition__foot">
					<span className="author">@{definition.author}</span>
					<span className="dot">·</span>
					<span>{formatAgoTR(definition.createdAt)}</span>
					<span className="actions">
						<button type="button">paylaş</button>
						<button type="button">kalıcı bağlantı</button>
						<button type="button">bildir</button>
					</span>
				</footer>
			</div>
		</article>
	);
}

/**
 * Definition body — split paragraphs on blank lines, fenced code as <pre>,
 * inline `code` and **strong** via the shared lib/markdown helpers. A real
 * markdown renderer (react-markdown + sanitizer) replaces this when content
 * gets richer.
 */
function Body({text}: {text: string}) {
	const blocks = splitMarkdownBlocks(text);
	return (
		<div className="kp-sozluk-definition__body">
			{blocks.map((block, i) => {
				if (block.kind === "code") {
					return <pre key={i}>{block.text}</pre>;
				}
				return <p key={i}>{renderMarkdownInline(block.text)}</p>;
			})}
		</div>
	);
}

const AddDefinitionMutation = graphql`
  mutation SozlukTermPageAddDefinitionMutation(
    $termSlug: String!
    $termTitle: String
    $body: String!
  ) {
    addDefinition(termSlug: $termSlug, termTitle: $termTitle, body: $body) {
      id
      body
      author
      score
      createdAt
      updatedAt
    }
  }
`;

const BODY_MAX = 10_000;

/**
 * Definition composer wired to the `addDefinition` mutation. Auth-required:
 * signed-out users get redirected to /auth?returnTo=<current>. On success
 * the parent's `onAdded` callback bumps `fetchKey` so the term query
 * re-fetches and the new definition appears in the list (Relay cache
 * invalidation per the task_4 spec).
 */
function Composer({slug, onAdded}: {slug: string; onAdded: () => void}) {
	const session = useSession();
	const navigate = useNavigate();
	const [body, setBody] = React.useState("");
	const [error, setError] = React.useState<string | null>(null);
	const [commit, isInFlight] =
		useMutation<SozlukTermPageAddDefinitionMutation>(AddDefinitionMutation);

	const trimmed = body.trim();
	const tooLong = body.length > BODY_MAX;
	const disabled = isInFlight || trimmed.length === 0 || tooLong;

	function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!session.data?.user) {
			const returnTo = encodeURIComponent(`/sozluk/${slug}`);
			navigate(`/auth?returnTo=${returnTo}`);
			return;
		}
		if (disabled) return;
		setError(null);
		commit({
			variables: {
				termSlug: slug,
				termTitle: slug.replace(/-/g, " "),
				body,
			},
			onCompleted: (_data, errors) => {
				if (errors && errors.length > 0) {
					setError(errors[0]?.message ?? "tanım eklenemedi");
					return;
				}
				setBody("");
				onAdded();
			},
			onError: (err) => {
				setError(err.message);
			},
		});
	}

	return (
		<form className="kp-sozluk-composer" onSubmit={onSubmit}>
			<header className="kp-sozluk-composer__head">
				<span className="kp-sozluk-composer__title">sen nasıl tanımlardın?</span>
			</header>
			<textarea
				className="kp-sozluk-composer__textarea"
				placeholder="markdown destekli. ```js ... ``` kod bloğu için. kişisel deneyim, örnek, hatıra; kuru sözlük tanımı zaten Wikipedia'da var."
				value={body}
				onChange={(e) => setBody(e.target.value)}
				disabled={isInFlight}
				data-testid="sozluk-composer-body"
				maxLength={BODY_MAX + 100}
			/>
			{error ? (
				<p className="kp-sozluk-composer__error" role="alert" data-testid="sozluk-composer-error">
					{error}
				</p>
			) : null}
			{tooLong ? (
				<p className="kp-sozluk-composer__error" role="alert">
					tanım en fazla {BODY_MAX} karakter olabilir ({body.length})
				</p>
			) : null}
			<footer className="kp-sozluk-composer__foot">
				<span className="kp-sozluk-composer__hint">
					markdown · <kbd>⌘</kbd>+<kbd>↵</kbd> gönder
				</span>
				<span style={{display: "flex", gap: 6}}>
					<Button
						variant="tertiary"
						size="sm"
						type="button"
						onClick={() => {
							setBody("");
							setError(null);
						}}
					>
						iptal
					</Button>
					<Button
						variant="primary"
						size="sm"
						type="submit"
						disabled={disabled}
						data-testid="sozluk-composer-submit"
					>
						{isInFlight ? "gönderiliyor…" : "tanımı ekle"}
					</Button>
				</span>
			</footer>
		</form>
	);
}
