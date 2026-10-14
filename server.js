// Call Routing Portal: serves the portal page and a REST API. No dependencies (Node 18+).
//   GET  /                                  portal (index.html)
//   GET  /api/routing                       all splits, nested   (?format=flat for a flat list)
//   PUT  /api/routing                       replace all splits (nested body, same shape as GET)
//   GET  /api/routing/:language/:type       one pair, e.g. /api/routing/EN/B2C
//   PUT  /api/routing/:language/:type       body {"TRANSCOM":60,"CONCENTRIX":40}
// Env: PORT (default 3000), DATA_FILE (default ./data.json), API_KEY (if set, writes need header x-api-key)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const API_KEY = process.env.API_KEY || '';

const LANGS = ['EN', 'FR', 'IT', 'CA', 'ES'];
const TYPES = ['PWD', 'B2C', 'B2B', 'PREMIUM', 'L&F', 'VY_CLUB', 'VY_VISA', 'PAE'];
const NO_CONCENTRIX = new Set(['B2B', 'L&F']);

const pair = (tx) => ({ TRANSCOM: tx, CONCENTRIX: 100 - tx });
const defaults = () => Object.fromEntries(LANGS.map(l => [l,
  Object.fromEntries(TYPES.map(t => [t, pair(NO_CONCENTRIX.has(t) ? 100 : 50)]))]));

class HttpError extends Error { constructor(status, msg){ super(msg); this.status = status; } }

// Validates one { TRANSCOM, CONCENTRIX } pair for a type; throws HttpError(400/422).
function validatePair(lang, type, p) {
  const id = `${lang}_${type}`;
  if (!p || typeof p !== 'object') throw new HttpError(400, `${id}: body must be {"TRANSCOM":n,"CONCENTRIX":n}`);
  const { TRANSCOM: tx, CONCENTRIX: cx } = p;
  for (const [name, v] of [['TRANSCOM', tx], ['CONCENTRIX', cx]])
    if (!Number.isInteger(v) || v < 0 || v > 100)
      throw new HttpError(400, `${id}_${name} must be a whole number between 0 and 100`);
  if (tx + cx !== 100) throw new HttpError(422, `${id}: TRANSCOM + CONCENTRIX must equal 100 (got ${tx + cx})`);
  if (NO_CONCENTRIX.has(type) && cx !== 0)
    throw new HttpError(422, `${id}: Concentrix does not handle ${type}; CONCENTRIX must be 0`);
  return pair(tx);
}

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return defaults(); }
}
function save(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
let data = load();

const flat = (d) => LANGS.flatMap(l => TYPES.flatMap(t =>
  ['TRANSCOM', 'CONCENTRIX']
    .filter(p => !(p === 'CONCENTRIX' && NO_CONCENTRIX.has(t)))
    .map(p => ({ key: `${l}_${t.replace('&', '')}_${p}`, language: l, type: t, partner: p, percentage: d[l][t][p] }))));

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) { reject(new HttpError(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : undefined); } catch { reject(new HttpError(400, 'Invalid JSON')); } });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (req.method === 'GET' && parts.length === 0)
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html');

  if (parts[0] !== 'api' || parts[1] !== 'routing') throw new HttpError(404, 'Not found');
  const [, , lang, type] = parts;

  if (req.method === 'GET') {
    if (!lang) return send(res, 200, url.searchParams.get('format') === 'flat' ? flat(data) : data);
    if (!LANGS.includes(lang) || !TYPES.includes(type)) throw new HttpError(404, 'Unknown language or type');
    return send(res, 200, data[lang][type]);
  }

  if (req.method === 'PUT') {
    if (API_KEY && req.headers['x-api-key'] !== API_KEY) throw new HttpError(401, 'Missing or invalid x-api-key');
    const body = await readBody(req);
    if (!lang) {                       // bulk replace: every language and type must be present
      const next = {};
      for (const l of LANGS) {
        next[l] = {};
        for (const t of TYPES) next[l][t] = validatePair(l, t, body?.[l]?.[t]);
      }
      data = next; save(data);
      return send(res, 200, data);
    }
    if (!LANGS.includes(lang) || !TYPES.includes(type)) throw new HttpError(404, 'Unknown language or type');
    data[lang][type] = validatePair(lang, type, body);
    save(data);
    return send(res, 200, data[lang][type]);
  }

  throw new HttpError(405, 'Method not allowed');
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
  });
}).listen(PORT, () => console.log(`Call Routing Portal on http://localhost:${PORT}`));
