import * as React from "react";
import {useNavigate} from "react-router";
import {slugifyTerm} from "../../lib/slugifyTerm";
import {Button} from "../ui/Button";
import {Dialog} from "../ui/Dialog";
import {Form, Input} from "../ui/Form";
import {useSozlukCreateDialog} from "./SozlukCreateDialogState";

/**
 * sözlük's contextual create CTA — the `+ yeni tanım` promoted verb in its Subnav
 * `primaryAction` zone (design-system-manifest: a product-scoped create CTA is a
 * contextual primary action; placement law #2587). It replaces the old go-to-or-create
 * box, whose "go to a term" search half folded into the global ⌘K `ara` (#2995, the #2412
 * single-search contract) leaving only the create half here as a plain action, never a
 * second search surface.
 *
 * A dialog collects the term name because the composer is slug-addressed (`/sozluk/:slug`):
 * the submit slugifies the typed term (`slugifyTerm`) and routes to the fresh-slug composer
 * branch — the exact target the old box reached, create dead-end handled there (#97).
 */
export function SozlukSubnavCta() {
	// `open` is hoisted above the FateProvider/needsBootstrap unmounting boundary (#3840) —
	// see `SozlukCreateDialogState`. A component-local `useState` here is the exact fragility
	// #3600 pinned: an ancestor unmount would silently reset it, vanishing the dialog.
	const {open, setOpen} = useSozlukCreateDialog();
	const navigate = useNavigate();
	const [term, setTerm] = React.useState("");
	const [termError, setTermError] = React.useState<string | null>(null);
	function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const validationError = validateTerm(term);
		if (validationError) {
			setTermError(validationError);
			return;
		}
		const slug = slugifyTerm(term);
		if (!slug) return;
		setOpen(false);
		setTerm("");
		setTermError(null);
		navigate(`/sozluk/${slug}`);
	}
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setTermError(null);
			}}
			trigger={
				<Button variant="primary" icon={<PlusGlyph />}>
					yeni tanım
				</Button>
			}
			title="Yeni tanım"
			description="oluşturmak istediğin terimi yaz."
		>
			<Form onSubmit={onSubmit}>
				<Input
					name="term"
					label="Terim"
					className="kp-field--semantic-required"
					value={term}
					onChange={(event) => {
						setTerm(event.currentTarget.value);
						setTermError(null);
					}}
					error={termError}
					required
					autoFocus
					fullWidth
					placeholder="terim…"
				/>
				<div className="kp-dialog-actions">
					<Button variant="tertiary" type="button" onClick={() => setOpen(false)}>
						vazgeç
					</Button>
					<Button variant="primary" type="submit">
						oluştur
					</Button>
				</div>
			</Form>
		</Dialog>
	);
}

// A punctuation-only term (e.g. "!!!") is a non-empty value `required` accepts but that
// `slugifyTerm` reduces to "" — the composer is slug-addressed, so it has nowhere to go.
// Surfacing it through Manti Input's error slot replaces the
// silent no-op the bare `if (!slug) return` guard left behind (#3789). Empty is left to
// `required`; only the non-empty-but-unslugifiable term errors here. Turkish copy, per the
// user-facing sözlük surface (.glossary/LANGUAGE.md).
const UNSLUGIFIABLE_TERM_MESSAGE = "Terim en az bir harf ya da rakam içermeli.";

function validateTerm(value: unknown): string | null {
	const term = String(value ?? "");
	if (!term.trim()) return null;
	return slugifyTerm(term) ? null : UNSLUGIFIABLE_TERM_MESSAGE;
}

function PlusGlyph() {
	return (
		<svg
			width="11"
			height="11"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.4"
			aria-hidden="true"
		>
			<path d="M12 5v14M5 12h14" />
		</svg>
	);
}
