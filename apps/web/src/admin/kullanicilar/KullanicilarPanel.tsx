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
 * Per-row role affordance (#3523): the `rol işlemleri` column wires the `user.setRole`
 * mutation (#3522) behind its OWN default-off `phoenix-user-role-assign` flag, so the whole
 * column is invisible until both that flag and `phoenix-user-admin` are on. The remaining
 * per-user action (yasakla/kaldır) is a sibling child, wired later.
 *
 * Render decisions live DOM-free in `kullanicilar.ts` / `role-controls.ts` (unit-tested);
 * this is the thin shell.
 * a11y: a labelled region + table; search is a real `<form>`; every cell is text, never
 * color; lowercase Turkish copy per the design law.
 */
import {Suspense, useState} from "react";
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import type {UserAdmin} from "../../../worker/features/fate/views";
import {Button} from "../../components/ui/Button";
import {FlagGate} from "../../flags/FlagGate";
import {PHOENIX_USER_ADMIN, PHOENIX_USER_ROLE_ASSIGN} from "../../flags/keys";
import {useFlag} from "../../flags/useFlag";
import "./KullanicilarPanel.css";
import {banLabel, createdAtLabel, roleLabel, usernameLabel} from "./kullanicilar";
import {RoleControls} from "./RoleControls";

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
	// Bumped after a role assignment to remount RosterList, forcing a fresh network-only
	// re-read so the row's derived `role` re-resolves through the gated view (#3523). A
	// `RoleState` write doesn't touch the `UserAdmin` entity in the store, so the row can't
	// self-update — the re-read is what reflects it.
	const [reloadNonce, setReloadNonce] = useState(0);

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
					data-testid="kullanicilar-search-button"
				>
					ara
				</Button>
			</form>
			<Suspense fallback={<p className="kp-kullanicilar__loading">yükleniyor…</p>}>
				<RosterList
					key={reloadNonce}
					search={applied}
					onRoleChanged={() => setReloadNonce((n) => n + 1)}
				/>
			</Suspense>
		</section>
	);
}

function RosterList({
	search,
	onRoleChanged,
}: {
	readonly search: string;
	readonly onRoleChanged: () => void;
}) {
	// The role-assign column is gated on its OWN dark-ship flag (#3522), evaluated once
	// here so the whole column — header + cells — appears or disappears as a unit: flag
	// off ⇒ no action column at all (not an empty one), the invisible-Denied client half.
	// The panel already sits inside the `phoenix-user-admin` FlagGate, so both flags must
	// be on for the controls to render.
	const {value: roleAssignOn} = useFlag(PHOENIX_USER_ROLE_ASSIGN, false);
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
					{roleAssignOn ? <th scope="col">rol işlemleri</th> : null}
				</tr>
			</thead>
			<tbody>
				{items.map(({node}) => (
					<RosterRow
						key={node.id}
						node={node}
						roleAssignOn={roleAssignOn}
						onRoleChanged={onRoleChanged}
					/>
				))}
			</tbody>
		</table>
	);
}

function RosterRow({
	node,
	roleAssignOn,
	onRoleChanged,
}: {
	readonly node: ViewRef<"UserAdmin">;
	readonly roleAssignOn: boolean;
	readonly onRoleChanged: () => void;
}) {
	const data = useView(UserAdminRowView, node);
	return (
		<tr data-testid={`kullanicilar-row-${data.id}`}>
			<td className="kp-kullanicilar__username">{usernameLabel(data.username)}</td>
			<td>{data.email}</td>
			<td>{roleLabel(data.role)}</td>
			<td data-testid={`kullanicilar-ban-${data.id}`}>{banLabel(data.banned)}</td>
			<td>{data.tier}</td>
			<td>{createdAtLabel(data.createdAt)}</td>
			{roleAssignOn ? (
				<td className="kp-kullanicilar__actions">
					<RoleControls userId={data.id} platformRole={data.role} onRoleChanged={onRoleChanged} />
				</td>
			) : null}
		</tr>
	);
}
