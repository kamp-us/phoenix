/**
 * Seed posts inserted on first init of the Pano DO. Empty-table check, so
 * subsequent boots are no-ops. Mirrors `apps/web/src/fixtures.tsx`'s POSTS /
 * COMMENTS shape so a fresh deployment renders the design system with real
 * shape rather than a blank feed. Authors are pulled from the same pool as
 * the sözlük seed for visual consistency across the two products.
 */
export type SeedTag = {
	kind: string;
	label: string;
};

export type SeedComment = {
	authorId: string;
	authorName: string;
	body: string;
	score: number;
	/** Index into the parent post's `comments` array. `null` = top-level. */
	parentIdx?: number;
};

export type SeedPost = {
	title: string;
	url?: string;
	body?: string;
	authorId: string;
	authorName: string;
	score: number;
	tags: SeedTag[];
	comments: SeedComment[];
};

const author = (name: string) => ({authorId: `seed_${name}`, authorName: name});

export const SEED_POSTS: SeedPost[] = [
	{
		...author("eda_k"),
		title: "türkiye'de kendi web yığınını çalıştırmak: nginx + caddy notları",
		url: "https://github.com/edak/notes",
		score: 47,
		tags: [{kind: "göster", label: "göster"}],
		comments: [
			{
				...author("eda_k"),
				score: 12,
				body: "caddy ile başlamak çok daha kolay, özellikle TLS otomatik. nginx benim için sadece eski projeler için kalıyor artık. `caddy reverse_proxy` tek satır yeter.",
			},
			{
				...author("mert"),
				score: 5,
				body: "katılıyorum ama büyük setup'larda hala nginx daha öngörülebilir geliyor bana. config örneklerin bol.",
				parentIdx: 0,
			},
			{
				...author("eda_k"),
				score: 3,
				body: "haklısın, ölçek meselesi. küçük foruma **caddy** sevimli geliyor, kurumsal bir şey için nginx mantıklı.",
				parentIdx: 1,
			},
			{
				...author("arda"),
				score: 2,
				body: "yazıdaki rate-limit kısmı çok temiz, teşekkürler. ufak bir not: leaky-bucket yerine token-bucket örneği koysan daha iyi olabilir, kullanıcılar pratikte burst istiyor.",
			},
		],
	},
	{
		...author("mert"),
		title: 'küçük bir forum yazılımı için "yeterince iyi" oran sınırlama',
		body: "kampus.dev'de oran sınırlamayı düşünüyorum. 5 sn'de 1 post yeterli mi? 10 sn'de 1? deneyimi olan var mı?",
		score: 63,
		tags: [
			{kind: "tartışma", label: "tartışma"},
			{kind: "soru", label: "soru"},
		],
		comments: [
			{
				...author("canyilmaz"),
				score: 18,
				body: "token-bucket per-user, 1 token / 10sn, burst 3. küçük topluluk için yeter. redis bile gerekmez, in-memory map yeter.",
			},
			{
				...author("elif"),
				score: 7,
				body: "anti-spam değilse oran sınırlama aslında UX problemi. bot tehdidi yoksa rahat bırak.",
			},
		],
	},
	{
		...author("arda"),
		title: "oyun motoru yazıyorum ama wgpu nasıl debug ediliyor cidden bilen var mı",
		body: "renderdoc çalışıyor mu wgpu ile? naga shader'larını okurken kafam karışıyor.",
		score: 21,
		tags: [{kind: "söylenme", label: "söylenme"}],
		comments: [
			{
				...author("kaaneren"),
				score: 9,
				body: "renderdoc native API üstünden çalışıyor, vulkan backend kullanıyorsan göreceksin. dx12 backend'inde de ok. metal'de pix yok, malesef.",
			},
			{
				...author("arda"),
				score: 2,
				body: "vulkan'da deneyeceğim, teşekkürler. naga sorununu da `WGPU_BACKEND=vulkan` ile sabitleyince log'lar daha okunabilir oluyor zaten.",
				parentIdx: 0,
			},
		],
	},
	{
		...author("selin"),
		title: "CSS'de container queries'ten sonra dünya değişti mi",
		url: "https://css-tricks.com/say-hello-to-css-container-queries/",
		score: 88,
		tags: [{kind: "tartışma", label: "tartışma"}],
		comments: [
			{
				...author("merve.kaya"),
				score: 22,
				body: "değişti. sidebar component'lerinin parent'a göre adapt olması artık doğal hissediyor. `@container (min-width: 480px)` lego gibi.",
			},
			{
				...author("ali.tuncay"),
				score: 11,
				body: "media query yerine container query ile design system component'leri tek başına test edilebiliyor — storybook ile çok güzel oturuyor.",
			},
			{
				...author("kerem"),
				score: 4,
				body: "tarayıcı desteği nasıl peki? eski safari'de `@container` çalışıyor mu?",
				parentIdx: 0,
			},
			{
				...author("merve.kaya"),
				score: 6,
				body: "safari 16+, modern hepsi tamam. caniuse'a bak, %94 civarı global.",
				parentIdx: 2,
			},
		],
	},
	{
		...author("kerem"),
		title: "neden hala IRC kullanıyorum",
		body: "discord/slack ergonomi olarak iyi ama kontrol bende değil. weechat + bouncer kombosu 15 yıldır aynı şekilde çalışıyor — bu kadar.",
		score: 34,
		tags: [{kind: "meta", label: "meta"}],
		comments: [
			{
				...author("umutsirin"),
				score: 14,
				body: "bouncer denemiştim, ZNC sanırım. en güzel yanı: 3 ay sonra giriş yapsam da topluluğun konuşmasını okuyabiliyordum. discord'da o yok.",
			},
			{
				...author("meriç"),
				score: 5,
				body: "matrix bridge kullanıyorum, IRC kanallarına matrix client'tan giriyorum. iki dünyanın iyi tarafı.",
			},
		],
	},
	{
		...author("canyilmaz"),
		title: "sqlite-in-DO patterni: bir yıl üretimde",
		url: "https://canyilmaz.dev/posts/sqlite-do-postmortem",
		score: 56,
		tags: [
			{kind: "göster", label: "göster"},
			{kind: "tartışma", label: "tartışma"},
		],
		comments: [
			{
				...author("eda_k"),
				score: 8,
				body: "DO başına storage limiti 10GB, bu sana sıkıştı mı hiç?",
			},
			{
				...author("canyilmaz"),
				score: 11,
				body: 'tek user için sıkışmadı; çoklu-user arenada zaten DO sharding yapıyoruz. ama "global state" tipi DO\'larda dikkatli olmak lazım.',
				parentIdx: 0,
			},
		],
	},
	{
		...author("elif"),
		title: "frontend'te 'feature flag' nasıl yönetiyorsunuz",
		body: "küçük takımız, vercel/launchdarkly overkill geliyor. env var + cookie yetiyor mu sizce?",
		score: 29,
		tags: [{kind: "soru", label: "soru"}],
		comments: [
			{
				...author("mert"),
				score: 9,
				body: "küçük takım için: bir `flags.json` dosyası, build time inject. kullanıcı segmentasyonu yoksa runtime'a bile gerek yok.",
			},
		],
	},
];
