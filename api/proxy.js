/**
 * ═══════════════════════════════════════════════════════════
 *  CORS PROXY — Vercel Serverless Function
 *  Dosya: api/proxy.js
 *
 *  Kullanım: GET /api/proxy?url=https://hedefsite.com
 *
 *  Deploy: Bu klasörü Vercel'e yükle → otomatik aktif olur.
 *  Ücretsiz plan: Ayda 100.000 istek, 10 sn timeout
 * ═══════════════════════════════════════════════════════════
 */

// İzin verilen kaynak origin'ler — kendi domain'inizi ekleyin
const ALLOWED_ORIGINS = [
  'https://seninsiten.com',       // ← buraya kendi domain'inizi yazın
  'https://www.seninsiten.com',
  'http://localhost:3000',        // geliştirme ortamı
  'http://localhost:5500',        // VS Code Live Server
  'null',                         // file:// protokolü (yerel HTML açma)
];

// Güvenlik: Proxy'nin erişmesine izin verilmeyen host'lar
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '169.254.',   // link-local
  '10.',        // private network
  '192.168.',   // private network
  '172.16.',    // private network
];

// İstek limiti (çok basit bellek tabanlı — production'da Redis kullanın)
const rateMap = new Map();
const RATE_LIMIT = 30;      // dakikada max istek
const RATE_WINDOW = 60000;  // 1 dakika (ms)

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';

  // ── CORS başlıkları ──────────────────────────────────────
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || origin === '';
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? (origin || '*') : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Sadece GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Sadece GET istekleri desteklenir.' });
  }

  // ── Rate limiting ────────────────────────────────────────
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateMap.get(clientIp) || { count: 0, reset: now + RATE_WINDOW };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + RATE_WINDOW; }
  entry.count++;
  rateMap.set(clientIp, entry);

  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({
      error: 'Rate limit aşıldı. 1 dakika sonra tekrar deneyin.',
      resetAt: new Date(entry.reset).toISOString()
    });
  }

  // ── URL parametresini al ve doğrula ─────────────────────
  const targetUrl = req.query?.url;

  if (!targetUrl) {
    return res.status(400).json({ error: '?url parametresi gerekli. Örnek: /api/proxy?url=https://site.com' });
  }

  // URL formatını doğrula
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Geçersiz URL formatı.' });
  }

  // Sadece http/https
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Sadece http ve https URL\'leri desteklenir.' });
  }

  // Güvenlik: private network'lere erişimi engelle (SSRF önlemi)
  const host = parsedUrl.hostname;
  const isBlocked = BLOCKED_HOSTS.some(blocked => host.startsWith(blocked) || host === blocked);
  if (isBlocked) {
    return res.status(403).json({ error: 'Bu host\'a erişim engellendi.' });
  }

  // ── Hedef siteyi fetch et ────────────────────────────────
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000); // 9 sn timeout

  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        // Gerçek tarayıcı gibi görün — bazı siteler bot'ları reddeder
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(502).json({
        error: `Hedef site ${response.status} döndürdü.`,
        statusCode: response.status
      });
    }

    // Content-Type kontrolü — sadece HTML/text al
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('application/xhtml')) {
      return res.status(415).json({ error: 'Sadece HTML/metin içerik destekleniyor.' });
    }

    // Boyut sınırı — 2MB üstünü reddet
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    if (contentLength > 2 * 1024 * 1024) {
      return res.status(413).json({ error: 'Sayfa 2MB sınırını aşıyor.' });
    }

    const html = await response.text();

    // ── allorigins formatıyla uyumlu yanıt döndür ──────────
    // (HTML'deki mevcut kod bu formatı bekliyor, değiştirme gerekmez)
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 dk cache
    return res.status(200).json({
      contents: html,
      status: { url: targetUrl, content_type: contentType, http_code: response.status }
    });

  } catch (err) {
    clearTimeout(timeout);

    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Hedef site 9 saniyede yanıt vermedi (timeout).' });
    }

    console.error('[proxy] fetch error:', err.message);
    return res.status(502).json({ error: 'Siteye bağlanılamadı: ' + err.message }){
  "functions": {
    "api/proxy.js": {
      "maxDuration": 10,
      "memory": 128
    }
  },
  "headers": [
    {
      "source": "/api/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ]
}
;
  }
}
