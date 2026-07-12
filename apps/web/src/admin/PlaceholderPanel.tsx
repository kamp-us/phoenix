/**
 * The placeholder console module panel (#2740, epic #2711) — a real, lazily-rendered
 * tenant that proves the module-registry contract renders end-to-end before any real
 * module exists. The first real tenant is the flags module (#2742); this is replaced by
 * it (or deleted) then. Lowercase-Turkish copy per the design law.
 */
export default function PlaceholderPanel() {
	return (
		<section aria-label="yer tutucu" data-testid="admin-placeholder-panel">
			<p>bu bir yer tutucu modül. gerçek modüller (bayraklar, kullanıcılar) buraya bağlanacak.</p>
		</section>
	);
}
