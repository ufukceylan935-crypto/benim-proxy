const https = require('https');
const http  = require('http');
const { URL } = require('url');

const BLOCKED_HOSTS = ['localhost','127.0.0.1','0.0.0.0','169.254.','10.','192.168.','172.16.'];

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Sadece GET desteklenir.' });

  const targetUrl = req.query && req.query.url;
  if (!targetUrl) return res.status(400).json({ error: '?url parametresi gerekli.' });

  let parsed;
  try { parsed = new URL(targetUrl); } catch(e) {
    return res.status(400).json({ error: 'Gecersiz URL.' });
  }

  if (!['http:', 'https:'].includes(parsed.protocol))
    return res.status(400).json({ error: 'Sadece http/https desteklenir.' });

  const host = parsed.hostname;
  if (BLOCKED_HOSTS.some(b => host === b || host.startsWith(b)))
    return res.status(403).json({ error: 'Bu host engellendi.' });

  try {
    const html = await fetchUrl(targetUrl);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json({ contents: html });
  } catch(err) {
    return res.status(502).json({ error: 'Baglanamadi: ' + err.message });
  }
};

function fetchUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      timeout:  9000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.7',
      }
    };

    const request = lib.request(options, (response) => {
      // Redirect takibi (max 3)
      if ([301,302,303,307,308].includes(response.statusCode) && response.headers.location) {
        try {
          const redirectUrl = new URL(response.headers.location, targetUrl).href;
          resolve(fetchUrl(redirectUrl));
        } catch(e) { reject(new Error('Redirect hatasi: ' + e.message)); }
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error('HTTP ' + response.statusCode));
        return;
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      response.on('error', reject);
    });

    request.on('timeout', () => { request.destroy(); reject(new Error('Timeout (9sn)')); });
    request.on('error', reject);
    request.end();
  });
}
