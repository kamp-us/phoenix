/**
 * fate-shaped definition card.
 *
 * Reads its data via `useView(DefinitionView, ref)` — the term page composes
 * `DefinitionView` into the `Term.definitions` connection and hands each node
 * `ViewRef` down. The card declares the fields it needs (`DefinitionView`); fate
 * masks everything else.
 *
 * Vote / edit / delete are owned by the card and dispatched through
 * `fate.mutations.definition.*` with declarative `optimistic` updates:
 *  - vote / retractVote flip `score` + `myVote` instantly, roll back on error.
 *  - edit writes the new body back through `DefinitionView`.
 *  - delete is a `Term`-returning mutation (parent re-resolved); the row lives in
 *    the nested `Term.definitions` connection, which `insert`/`delete` can't
 *    touch, so we reload after success.
 *
 * Error routing: the client derives callSite-vs-boundary from the wire `code`,
 * and phoenix's wider codes resolve to `status: undefined` → boundary, so the
 * mutation *throws* instead of returning `{error}`; we catch at the call site.
 * The optimistic rollback already fired before the throw; we read `.code` and
 * surface it inline keyed on the code (`UNAUTHORIZED` → auth redirect). See
 * `.patterns/fate-mutations-client.md`.
 */
import * as React from "react";
import {useFateClient, useLiveView, type ViewRef, view} from "react-fate";
import {useNavigate} from "react-router";
import type {Definition} from "../../../worker/fate/views";
import {useSession} from "../../auth/client";
import {codeOf, toIso} from "../../fate/wire";
import {formatAgoTR} from "../../lib/datetime";
import {renderMarkdownInline, splitMarkdownBlocks} from "../../lib/markdown";
import type {MutationErrorCode} from "../../lib/mutationErrorCodes";
import {authRedirectPath} from "../../lib/returnTo";
import {Button} from "../ui/Button";
import {Dialog} from "../ui/Dialog";
import {EditedIndicator} from "../ui/EditedIndicator";

/** The fields a definition card reads. Co-located with the component. */
export const DefinitionView = view<Definition>()({
	id: true,
	body: true,
	score: true,
	myVote: true,
	createdAt: true,
	updatedAt: true,
	author: true,
	authorId: true,
});

const BODY_MAX = 10_000;

/** Turkish copy for the validation / not-found codes a card surfaces inline. */
const messageForCode = (code: MutationErrorCode, fallback: string): string => {
	switch (code) {
		case "BODY_REQUIRED":
			return "tanım boş olamaz";
		case "BODY_TOO_LONG":
			return `tanım en fazla ${BODY_MAX} karakter olabilir`;
		case "DEFINITION_NOT_FOUND":
			return "tanım bulunamadı";
		default:
			return fallback;
	}
};

export interface DefinitionCardProps {
	/** View ref into a Definition node from the term's definitions connection. */
	definition: ViewRef<"Definition">;
	rank: number;
	top: boolean;
	/** Term slug — passed to the auth redirect so a signed-out vote returns here. */
	slug: string;
}

export function DefinitionCard(props: DefinitionCardProps) {
	// Live: a definition vote/edit on another client publishes
	// `live.update("Definition", id, …)` with the re-resolved node inline, so the
	// score/body re-render here without a refetch.
	const definition = useLiveView(DefinitionView, props.definition);
	const fate = useFateClient();
	const session = useSession();
	const navigate = useNavigate();

	const [editing, setEditing] = React.useState(false);
	const [editBody, setEditBody] = React.useState(definition.body);
	const [editError, setEditError] = React.useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = React.useState(false);
	const [deleteError, setDeleteError] = React.useState<string | null>(null);
	const [inFlight, setInFlight] = React.useState(false);
	const [editInFlight, setEditInFlight] = React.useState(false);
	const [deleteInFlight, setDeleteInFlight] = React.useState(false);

	const voted = (definition.myVote ?? 0) === 1;
	const cls = props.top ? "kp-sozluk-definition kp-sozluk-definition--top" : "kp-sozluk-definition";
	const isAuthor = !!session.data?.user && session.data.user.id === definition.authorId;

	/** Signed-out → bounce to auth; returns true when a redirect was issued. */
	function redirectIfSignedOut(): boolean {
		if (!session.data?.user) {
			navigate(authRedirectPath(`/sozluk/${props.slug}`));
			return true;
		}
		return false;
	}

	async function onVoteClick() {
		if (redirectIfSignedOut() || inFlight) return;
		setInFlight(true);
		try {
			if (voted) {
				await fate.mutations.definition.retractVote({
					input: {id: definition.id},
					optimistic: {score: Math.max(0, definition.score - 1), myVote: null},
					view: DefinitionView,
				});
			} else {
				await fate.mutations.definition.vote({
					input: {id: definition.id},
					optimistic: {score: definition.score + 1, myVote: 1},
					view: DefinitionView,
				});
			}
		} catch (error) {
			// Boundary-class throw (fate classifies phoenix codes as boundary).
			// The optimistic flip already rolled back; surface UNAUTHORIZED as a
			// redirect, otherwise stay silent on the vote button (no inline slot).
			if (codeOf(error) === "UNAUTHORIZED") redirectIfSignedOut();
		} finally {
			setInFlight(false);
		}
	}

	async function onEditSubmit(e: React.FormEvent) {
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
		setEditInFlight(true);
		try {
			const {error} = await fate.mutations.definition.edit({
				input: {id: definition.id, body: editBody},
				view: DefinitionView,
			});
			if (error) {
				setEditError(messageForCode(codeOf(error), error.message));
				return;
			}
			setEditing(false);
		} catch (error) {
			const code = codeOf(error);
			if (code === "UNAUTHORIZED") {
				redirectIfSignedOut();
				return;
			}
			setEditError(messageForCode(code, "tanım güncellenemedi"));
		} finally {
			setEditInFlight(false);
		}
	}

	async function onDeleteConfirm() {
		setDeleteError(null);
		setDeleteInFlight(true);
		try {
			// `definition.delete` is a **`Term`** mutation (it returns the re-resolved
			// parent so counts update), so fate's `delete: true` can't be used — it
			// would `deleteRecord("Term", definitionId)`, the wrong entity. And the
			// definition lives in the *nested* `Term.definitions` connection, whose
			// membership `insert`/`delete` can't touch. The resolver instead publishes
			// `live.connection("Term.definitions", {id: slug}).deleteEdge`, which the
			// list's `useLiveListView` consumes — the card drops out in place (this
			// client's own view included), no reload.
			const {error} = await fate.mutations.definition.delete({
				input: {id: definition.id},
			});
			if (error) {
				setDeleteError(messageForCode(codeOf(error), error.message));
				return;
			}
			setConfirmDelete(false);
		} catch (error) {
			const code = codeOf(error);
			if (code === "UNAUTHORIZED") {
				redirectIfSignedOut();
				return;
			}
			setDeleteError(messageForCode(code, "tanım silinemedi"));
		} finally {
			setDeleteInFlight(false);
		}
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
					<span>{formatAgoTR(toIso(definition.createdAt))}</span>
					<EditedIndicator
						createdAt={toIso(definition.createdAt)}
						updatedAt={toIso(definition.updatedAt)}
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
