/**
 * `KullanicilarPanel` — the kullanıcılar (user-roster) admin console module (#3200), the
 * React consumer of the gated `userAdmin.list` read. It lists the paginated, searchable
 * user roster (kullanıcı adı, e-posta, rol, durum, seviye, kayıt) inside the shipped
 * `AdminConsole` shell.
 *
 * Gated behind the default-off `phoenix-user-admin` flag via `FlagGate` (the email-delivery
 * module's stance): with it off nothing renders and no roster request fires, so the surface
 * ships dark until a human flips the flag (ADR 0083) — the client half of the two-gate
 * contract whose worker half fails the invisible `Denied`.
 *
 * READ-ONLY: the per-user actions (rol ata, yasakla/kaldır) are a sibling child that wires
 * the already-shipped mutations into these rows later — this slice lists + searches only.
 *
 * Render decisions live DOM-free in `kullanicilar.ts` (unit-tested); this is the thin shell.
 * a11y: a labelled region + table; search is a real `<form>`; every cell is text, never
 * color; lowercase Turkish copy per the design law.
 */
import {Suspense, useState} from "react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {UserAdmin} from "../../../worker/features/fate/views";
import {Button} from "../../components/ui/Button";
import {FlagGate} from "../../flags/FlagGate";
import {PHOENIX_USER_ADMIN} from "../../flags/keys";
import "./KullanicilarPanel.css";
import {banLabel, createdAtLabel, roleLabel, usernameLabel} from "./kullanicilar";

const ROSTER_PAGE_SIZE = 50;

const UserAdminRowView = view<UserAdmin>()({
	id: true,
	username: true,
	email: true,
	role: true,
	banned: true,
	tier: true,
	createdAt: true,
});

const UserAdminConnectionView = {items: {node: UserAdminRowView}} as const;

export default function KullanicilarPanel() {
	return (
		<FlagGate flag={PHOENIX_USER_ADMIN}>
			<KullanicilarRoster />
		</FlagGate>
	);
}

function KullanicilarRoster() {
	// The applied search is separate from the input value so a keystroke doesn't refetch the
	// roster — only submitting the form (or clearing it) changes the request args.
	const [draft, setDraft] = useState("");
	const [applied, setApplied] = useState("");

	function onSubmit(event: React.FormEvent) {
		event.preventDefault();
		setApplied(draft.trim());
	}

	return (
		<section className="kp-kullanicilar" aria-label="kullanıcılar" data-testid="kullanicilar-panel">
			<form className="kp-kullanicilar__search" onSubmit={onSubmit} aria-label="kullanıcı ara">
				<label className="kp-kullanicilar__field">
					ara
					<input
						className="kp-kullanicilar__search-input"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="kullanıcı adı, e-posta…"
						data-testid="kullanicilar-search-input"
					/>
				</label>
				<Button
					variant="secondary"
					size="sm"
					type="submit"
					className="kp-kullanicilar__btn"
					data-testid="kullanicilar-search-button"
				>
					ara
				</Button>
			</form>
			<Suspense fallback={<p className="kp-kullanicilar__loading">yükleniyor…</p>}>
				<RosterList search={applied} />
			</Suspense>
		</section>
	);
}

function RosterList({search}: {readonly search: string}) {
	const result = useRequest(
		{
			"userAdmin.list": {
				list: UserAdminConnectionView,
				args: {first: ROSTER_PAGE_SIZE, ...(search ? {search} : {})},
			},
		},
		{mode: "network-only"},
	);
	const [items] = useListView(UserAdminConnectionView, result["userAdmin.list"]);

	if (items.length === 0) {
		return (
			<p className="kp-kullanicilar__empty" data-testid="kullanicilar-empty">
				{search ? "aramanla eşleşen kullanıcı yok." : "henüz kullanıcı yok."}
			</p>
		);
	}

	return (
		<table className="kp-kullanicilar__table" data-testid="kullanicilar-table">
			<caption className="kp-kullanicilar__caption">kullanıcı listesi</caption>
			<thead>
				<tr>
					<th scope="col">kullanıcı adı</th>
					<th scope="col">e-posta</th>
					<th scope="col">rol</th>
					<th scope="col">durum</th>
					<th scope="col">seviye</th>
					<th scope="col">kayıt</th>
				</tr>
			</thead>
			<tbody>
				{items.map(({node}) => (
					<RosterRow key={node.id} node={node} />
				))}
			</tbody>
		</table>
	);
}

function RosterRow({node}: {readonly node: ViewRef<"UserAdmin">}) {
	const data = useView(UserAdminRowView, node);
	return (
		<tr data-testid={`kullanicilar-row-${data.id}`}>
			<td className="kp-kullanicilar__username">{usernameLabel(data.username)}</td>
			<td>{data.email}</td>
			<td>{roleLabel(data.role)}</td>
			<td data-testid={`kullanicilar-ban-${data.id}`}>{banLabel(data.banned)}</td>
			<td>{data.tier}</td>
			<td>{createdAtLabel(data.createdAt)}</td>
		</tr>
	);
}
