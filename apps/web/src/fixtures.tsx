import type { PanoPostData, CommentData } from './components/pano';
import type { TermRow } from './components/sozluk';
import { Code, Mark } from './components/ui/atoms';

export const POSTS: PanoPostData[] = [
  {
    id: 'p1', rank: 1, title: 'türkiye\'de kendi web yığınını çalıştırmak: nginx + caddy notları',
    href: '#', url: 'https://github.com/edak/notes', host: 'github.com',
    tags: [{ kind: 'show', label: 'göster' }],
    author: 'eda_k', agoLabel: '3 saat önce', commentCount: 14, score: 47, myVote: 1,
  },
  {
    id: 'p2', rank: 2, title: 'küçük bir forum yazılımı için "yeterince iyi" oran sınırlama',
    href: '#', host: 'kampus.dev',
    tags: [{ kind: 'discuss', label: 'tartışma' }, { kind: 'ask', label: 'soru' }],
    author: 'mert', agoLabel: '5 saat önce', commentCount: 28, score: 63,
  },
  {
    id: 'p3', rank: 3, title: 'oyun motoru yazıyorum ama wgpu nasıl debug ediliyor cidden bilen var mı',
    href: '#',
    tags: [{ kind: 'rant', label: 'söylenme' }],
    author: 'arda', agoLabel: '7 saat önce', commentCount: 9, score: 21,
  },
  {
    id: 'p4', rank: 4, title: 'CSS\'de container queries\'ten sonra dünya değişti mi',
    href: '#', host: 'css-tricks.com',
    tags: [{ kind: 'discuss', label: 'tartışma' }],
    author: 'selin', agoLabel: '12 saat önce', commentCount: 41, score: 88,
  },
  {
    id: 'p5', rank: 5, title: 'neden hala IRC kullanıyorum',
    href: '#',
    tags: [{ kind: 'meta', label: 'meta' }],
    author: 'kerem', agoLabel: '1 gün önce', commentCount: 17, score: 34,
  },
];

export const COMMENTS: CommentData[] = [
  {
    id: 'c1', hash: 'c_2814', author: 'eda_k', agoLabel: '2 saat önce',
    score: 12, isOwner: true, highlight: true,
    body: <p>caddy ile başlamak çok daha kolay, özellikle TLS otomatik. nginx benim için sadece eski projeler için kalıyor artık. <Code>caddy reverse_proxy</Code> tek satır yeter.</p>,
    children: [
      {
        id: 'c2', author: 'mert', agoLabel: '1 saat önce', score: 5,
        body: <p>katılıyorum ama büyük setup'larda hala nginx daha öngörülebilir geliyor bana. config örneklerin bol.</p>,
        children: [
          {
            id: 'c3', author: 'eda_k', agoLabel: '45 dakika önce', score: 3, isOwner: true,
            body: <p>haklısın, ölçek meselesi. küçük foruma <Mark>caddy</Mark> sevimli geliyor, kurumsal bir şey için nginx mantıklı.</p>,
          },
        ],
      },
    ],
  },
  {
    id: 'c4', author: 'arda', agoLabel: '30 dakika önce', score: 2,
    body: <p>yazıdaki rate-limit kısmı çok temiz, teşekkürler. ufak bir not: leaky-bucket yerine token-bucket örneği koysan daha iyi olabilir, kullanıcılar pratikte burst istiyor.</p>,
  },
];

export const TERMS: TermRow[] = [
  { slug: 'kampus',           title: 'kampüs',           count: 14 },
  { slug: 'pano',             title: 'pano',             count: 8 },
  { slug: 'sozluk',           title: 'sözlük',           count: 22 },
  { slug: 'manifesto',        title: 'manifesto',        count: 3 },
  { slug: 'caddy',            title: 'caddy',            count: 2 },
  { slug: 'nginx',            title: 'nginx',            count: 5 },
  { slug: 'rate-limiting',    title: 'rate limiting',    count: 4 },
  { slug: 'static-site',      title: 'static site',      count: 6 },
  { slug: 'turkce-yazisma',   title: 'türkçe yazışma',   count: 11 },
  { slug: 'irc',              title: 'irc',              count: 7 },
];

/* Sozluk home — recent terms (with one-line excerpt). */
export const SOZLUK_RECENT: TermRow[] = [
  { slug: 'race-condition',      title: 'race condition',      count: 14,
    excerpt: "İki goroutine'in aynı paylaşılan kaynağa kilitlenmeden vurması; gece 3'te seni uyandıran şey." },
  { slug: 'backpressure',        title: 'backpressure',        count: 9,
    excerpt: "Hızlı üreten, yavaş tüketen iki uç arasında trafiği yöneten karşı basınç mekanizması." },
  { slug: 'monad',               title: 'monad',               count: 22,
    excerpt: "Bir endofunctor kategorisindeki monoid. Sadece flatMap deyin, daha kısa." },
  { slug: 'idempotent',          title: 'idempotent',          count: 11,
    excerpt: "Aynı isteği iki kere göndersen de bir kere göndermişsin gibi davranan endpoint." },
  { slug: 'eventual-consistency', title: 'eventual consistency', count: 7,
    excerpt: "\"Eninde sonunda doğru olur\" — bazen sabaha, bazen production incident'ına kadar." },
  { slug: 'cargo-cult',          title: 'cargo cult',          count: 5,
    excerpt: "Niye yaptığını bilmeden, başkası yapıyor diye yapılan mühendislik kararları." },
  { slug: 'heisenbug',           title: 'heisenbug',           count: 8,
    excerpt: "Gözlemlemeye çalıştığın anda kaybolan bug. Debugger açınca ortadan yok olur." },
  { slug: 'flaky-test',          title: 'flaky test',          count: 6,
    excerpt: "Bazen geçen bazen düşen test. Genelde altta yatan bir race condition'dan beslenir." },
];

/* Sozluk home — most-upvoted terms (right column). */
export const SOZLUK_POPULAR = [
  { slug: 'callback-hell',          title: 'callback hell',          score: 312 },
  { slug: 'yak-shaving',            title: 'yak shaving',            score: 287 },
  { slug: 'technical-debt',         title: 'technical debt',         score: 274 },
  { slug: 'bikeshedding',           title: 'bikeshedding',           score: 258 },
  { slug: 'heisenbug',              title: 'heisenbug',              score: 241 },
  { slug: 'kestirme-yol',           title: 'kestirme yol (hack)',    score: 219 },
  { slug: 'premature-optimization', title: 'premature optimization', score: 203 },
];

/* Landing-row variant — terms with gloss + author + ago for the activity column. */
export const LANDING_TERMS = [
  { slug: 'race-condition',     title: 'race condition',      count: 17,
    gloss: 'yarış halinde erişimden doğan belirsizlik',
    author: 'umutsirin', agoLabel: '2 gün' },
  { slug: 'onbellek',           title: 'önbellek',            count: 12,
    gloss: 'hesaplanmış olanı saklama tekniği',
    author: 'arthur',    agoLabel: '3 gün' },
  { slug: 'yatay-olcekleme',    title: 'yatay ölçekleme',     count: 9,
    gloss: 'sunucu eklemekle olan',
    author: 'elif',      agoLabel: '4 gün' },
  { slug: 'crdt',               title: 'CRDT',                count: 8,
    gloss: 'çatışmasız çoğaltılan veri tipi',
    author: 'meriç',     agoLabel: '5 gün' },
  { slug: 'kimlik-dogrulama',   title: 'kimlik doğrulama',    count: 6,
    gloss: '"sen kimsin" sorusu',
    author: 'canyilmaz', agoLabel: '6 gün' },
];
