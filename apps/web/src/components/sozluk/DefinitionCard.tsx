/**
 * Fragment-shaped definition card.
 *
 * Reads its data via `useFragment(DefinitionCardFragment)` instead of taking
 * shaped props. The page (`SozlukTermPage`) spreads this fragment into the
 * `Term.definitionsConnection` selection and hands the fragment ref down —
 * the card declares what it needs.
 *
 * Vote / edit / delete affordances are owned by the card. Vote uses
 * `optimisticResponse` (carried over from MVP T5). Delete dispatches the
 * `@deleteRecord`-shaped mutation so the row disappears from the connection
 * without a refetch.
 */
import * as React from "react";
import {graphql, useFragment, useMutation} from "react-relay";
import {useNavigate} from "react-router";
import type {DefinitionCardDeleteMutation} from "../../__generated__/DefinitionCardDeleteMutation.graphql";
import type {DefinitionCardEditMutation} from "../../__generated__/DefinitionCardEditMutation.graphql";
import type {DefinitionCardFragment$key} from "../../__generated__/DefinitionCardFragment.graphql";
import type {DefinitionCardRetractVoteMutation} from "../../__generated__/DefinitionCardRetractVoteMutation.graphql";
import type {DefinitionCardVoteMutation} from "../../__generated__/DefinitionCardVoteMutation.graphql";
import {useSession} from "../../auth/client";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline, splitMarkdownBlocks} from "../../lib/markdown";
import {authRedirectPath} from "../../lib/returnTo";
import {useSessionExpiredToast} from "../../lib/useSessionExpiredToast";
import {Button} from "../ui/Button";
import {Dialog} from "../ui/Dialog";
import {EditedIndicator} from "../ui/EditedIndicator";

const DefinitionCardFragmentDef = graphql`
	fragment DefinitionCardFragment on Definition {
		id
		body
		score
		myVote
		createdAt
		updatedAt
		author
		authorId
	}
`;

const VoteDefinitionMutation = graphql`
	mutation DefinitionCardVoteMutation($definitionId: ID!) {
		voteDefinition(definitionId: $definitionId) {
			id
			score
			myVote
		}
	}
`;

const RetractDefinitionVoteMutation = graphql`
	mutation DefinitionCardRetractVoteMutation($definitionId: ID!) {
		retractDefinitionVote(definitionId: $definitionId) {
			id
			score
			myVote
		}
	}
`;

const EditDefinitionMutation = graphql`
	mutation DefinitionCardEditMutation($id: ID!, $body: String!) {
		editDefinition(id: $id, body: $body) {
			id
			body
			score
			updatedAt
		}
	}
`;

/**
 * Soft-delete a definition. Payload returns
 * `deletedDefinitionId @deleteRecord` so Relay drops the record from the
 * store and the connection edge auto-clears — no `$connections` variable,
 * no manual updater.
 */
const DeleteDefinitionMutation = graphql`
	mutation DefinitionCardDeleteMutation($id: ID!) {
		deleteDefinition(id: $id) {
			deletedDefinitionId @deleteRecord
		}
	}
`;

const BODY_MAX = 10_000;

export interface DefinitionCardProps {
	/** Fragment ref into a Definition row. */
	definition: DefinitionCardFragment$key;
	rank: number;
	top: boolean;
	/** Term slug — passed to the auth redirect so signed-out vote returns here. */
	slug: string;
}

export function DefinitionCard(props: DefinitionCardProps) {
	const definition = useFragment(DefinitionCardFragmentDef, props.definition);
	const session = useSession();
	const navigate = useNavigate();
	const {handleError: handleAuthError} = useSessionExpiredToast();
	const [voteCommit, voteInFlight] =
		useMutation<DefinitionCardVoteMutation>(VoteDefinitionMutation);
	const [retractCommit, retractInFlight] = useMutation<DefinitionCardRetractVoteMutation>(
		RetractDefinitionVoteMutation,
	);
	const [editCommit, editInFlight] =
		useMutation<DefinitionCardEditMutation>(EditDefinitionMutation);
	const [deleteCommit, deleteInFlight] =
		useMutation<DefinitionCardDeleteMutation>(DeleteDefinitionMutation);

	const [editing, setEditing] = React.useState(false);
	const [editBody, setEditBody] = React.useState(definition.body);
	const [editError, setEditError] = React.useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = React.useState(false);
	const [deleteError, setDeleteError] = React.useState<string | null>(null);

	const inFlight = voteInFlight || retractInFlight;
	const voted = (definition.myVote ?? 0) === 1;
	const cls = props.top
		? "kp-sozluk-definition kp-sozluk-definition--top"
		: "kp-sozluk-definition";
	const isAuthor = !!session.data?.user && session.data.user.id === definition.authorId;

	function onVoteClick() {
		if (!session.data?.user) {
			navigate(authRedirectPath(`/sozluk/${props.slug}`));
			return;
		}
		if (inFlight) return;
		if (voted) {
			retractCommit({
				variables: {definitionId: definition.id},
				optimisticResponse: {
					retractDefinitionVote: {
						id: definition.id,
						score: Math.max(0, definition.score - 1),
						myVote: null,
					},
				},
				onCompleted: (_data, errors) => {
					handleAuthError(errors);
				},
				onError: (err) => {
					handleAuthError(null, err);
				},
			});
		} else {
			voteCommit({
				variables: {definitionId: definition.id},
				optimisticResponse: {
					voteDefinition: {
						id: definition.id,
						score: definition.score + 1,
						myVote: 1,
					},
				},
				onCompleted: (_data, errors) => {
					handleAuthError(errors);
				},
				onError: (err) => {
					handleAuthError(null, err);
				},
			});
		}
	}

	function onEditSubmit(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = editBody.trim();
		if (trimmed.length === 0) {
			setEditError("tanım boş olamaz");
			return;
		}
		if (editBody.length > BODY_MAX) {
			setEditError(`tanım en fazla ${BODY_MAX} karakter olabilir`);
			return;
		}
		setEditError(null);
		editCommit({
			variables: {id: definition.id, body: editBody},
			onCompleted: (_data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setEditError(errors[0]?.message ?? "tanım güncellenemedi");
					return;
				}
				setEditing(false);
			},
			onError: (err) => {
				if (handleAuthError(null, err)) return;
				setEditError(err.message);
			},
		});
	}

	function onDeleteConfirm() {
		setDeleteError(null);
		deleteCommit({
			variables: {id: definition.id},
			onCompleted: (_data, errors) => {
				if (handleAuthError(errors)) return;
				if (errors && errors.length > 0) {
					setDeleteError(errors[0]?.message ?? "tanım silinemedi");
					return;
				}
				setConfirmDelete(false);
				// No `onMutated` plumbing — Relay's `@deleteRecord` directive on
				// the mutation payload removes the record from the store, the
				// connection edge auto-clears, and the row unmounts naturally.
			},
			onError: (err) => {
				if (handleAuthError(null, err)) return;
				setDeleteError(err.message);
			},
		});
	}

	return (
		<article className={cls} data-testid={`definition-card-${definition.id}`}>
			<div className="kp-sozluk-definition__vote">
				<button
					type="button"
					className="kp-sozluk-definition__vote-btn"
					aria-pressed={voted}
					aria-label={voted ? "Oyunu geri al" : "Yukarı oy"}
					data-testid={`definition-vote-${definition.id}`}
					disabled={inFlight}
					onClick={onVoteClick}
				>
					<span className="triangle" />
				</button>
				<span
					className="kp-sozluk-definition__vote-count"
					data-testid={`definition-score-${definition.id}`}
				>
					{definition.score}
				</span>
				<span className="kp-sozluk-definition__rank">#{props.rank}</span>
			</div>
			<div>
				{editing ? (
					<form className="kp-sozluk-composer" onSubmit={onEditSubmit}>
						<textarea
							className="kp-sozluk-composer__textarea"
							value={editBody}
							onChange={(e) => setEditBody(e.target.value)}
							disabled={editInFlight}
							data-testid={`definition-edit-body-${definition.id}`}
							maxLength={BODY_MAX + 100}
						/>
						{editError ? (
							<p
								className="kp-sozluk-composer__error"
								role="alert"
								data-testid={`definition-edit-error-${definition.id}`}
							>
								{editError}
							</p>
						) : null}
						<footer className="kp-sozluk-composer__foot">
							<span style={{display: "flex", gap: 6}}>
								<Button
									variant="tertiary"
									size="sm"
									type="button"
									disabled={editInFlight}
									onClick={() => {
										setEditing(false);
										setEditBody(definition.body);
										setEditError(null);
									}}
								>
									iptal
								</Button>
								<Button
									variant="primary"
									size="sm"
									type="submit"
									disabled={editInFlight || editBody.trim().length === 0}
									data-testid={`definition-edit-save-${definition.id}`}
								>
									{editInFlight ? "kaydediliyor…" : "kaydet"}
								</Button>
							</span>
						</footer>
					</form>
				) : (
					<DefinitionBody text={definition.body} />
				)}
				<footer className="kp-sozluk-definition__foot">
					<span className="author">@{definition.author}</span>
					<span className="dot">·</span>
					<span>{formatAgoTR(definition.createdAt)}</span>
					<EditedIndicator
						createdAt={definition.createdAt}
						updatedAt={definition.updatedAt}
					/>
					<span className="actions">
						<button type="button">paylaş</button>
						<button type="button">kalıcı bağlantı</button>
						<button type="button">bildir</button>
						{isAuthor && !editing ? (
							<>
								<button
									type="button"
									data-testid={`definition-edit-${definition.id}`}
									onClick={() => {
										setEditBody(definition.body);
										setEditError(null);
										setEditing(true);
									}}
								>
									düzenle
								</button>
								<button
									type="button"
									data-testid={`definition-delete-${definition.id}`}
									onClick={() => setConfirmDelete(true)}
								>
									sil
								</button>
							</>
						) : null}
					</span>
				</footer>
				{isAuthor ? (
					<Dialog.Root open={confirmDelete} onOpenChange={setConfirmDelete}>
						<Dialog.Popup>
							<Dialog.Head
								title="tanımı sil"
								description="bu tanımı silmek istediğine emin misin? geri alınamaz."
							/>
							<Dialog.Body>
								{deleteError ? (
									<p className="kp-sozluk-composer__error" role="alert">
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
									data-testid={`definition-delete-confirm-${definition.id}`}
									onClick={onDeleteConfirm}
								>
									{deleteInFlight ? "siliniyor…" : "sil"}
								</Button>
							</Dialog.Foot>
						</Dialog.Popup>
					</Dialog.Root>
				) : null}
			</div>
		</article>
	);
}

/**
 * Definition body — split paragraphs on blank lines, fenced code as <pre>,
 * inline `code` and **strong** via the shared lib/markdown helpers.
 */
function DefinitionBody({text}: {text: string}) {
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
