'use strict';
// Mining Game server: static game + API (leaderboard, global chat, clans).
// Walang npm dependencies. Kailangan: Node 18+ at env var DATABASE_URL (Neon connection string).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB = (process.env.DATABASE_URL || '').trim().replace(/^psql\s+/i, '').replace(/^['"]+|['"]+$/g, '').trim();
let NEON_URL = '';
try { if (DB) NEON_URL = 'https://' + new URL(DB.replace(/^postgres(?:ql)?:/, 'https:')).hostname + '/sql'; }
catch (e) { console.error('Mali ang DATABASE_URL format.'); }
if (!NEON_URL) console.error('WARNING: walang (o mali ang) DATABASE_URL. Hindi gagana ang online features.');

const CLAN_MAX = 30, CHAT_MAX = 140, CHAT_COOLDOWN = 1500;
const NAME_RE = /^[\p{L}\p{N} _-]{3,16}$/u;
const TAG_RE = /^[A-Z0-9]{2,4}$/;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

// ---------- DB (Neon SQL-over-HTTP, mula sa server kaya walang CORS issue) ----------
async function q(query, params = []) {
  if (!NEON_URL) throw new HttpError(503, 'Hindi naka-set ang database.');
  const r = await fetch(NEON_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': DB },
    body: JSON.stringify({ query, params }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error((j && j.message) || ('DB HTTP ' + r.status));
  return j.rows || [];
}

let ensured = null;
function ensure() {
  if (!ensured) {
    ensured = (async () => {
      await q(`CREATE TABLE IF NOT EXISTS mining_leaderboard (
        player_id text PRIMARY KEY, name text NOT NULL, xp bigint NOT NULL DEFAULT 0,
        rank_idx int NOT NULL DEFAULT 0, mines int NOT NULL DEFAULT 1,
        gold_earned bigint NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`);
      await q("ALTER TABLE mining_leaderboard ADD COLUMN IF NOT EXISTS avatar text NOT NULL DEFAULT ''");
      await q(`CREATE TABLE IF NOT EXISTS mining_clans (
        id bigserial PRIMARY KEY, name text NOT NULL, name_key text NOT NULL UNIQUE, tag text NOT NULL,
        leader_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS mining_clan_members (
        player_id text PRIMARY KEY, clan_id bigint NOT NULL, role text NOT NULL DEFAULT 'member',
        name text NOT NULL DEFAULT '', joined_at timestamptz NOT NULL DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS mining_chat (
        id bigserial PRIMARY KEY, channel text NOT NULL, player_id text NOT NULL, name text NOT NULL,
        tag text NOT NULL DEFAULT '', msg text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
      await q('CREATE INDEX IF NOT EXISTS mining_chat_ch ON mining_chat (channel, id DESC)');
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

// ---------- helpers ----------
const lastSend = new Map();   // pid -> ms
const ipHits = new Map();     // ip -> {n, t}
setInterval(() => { ipHits.clear(); const t = Date.now(); for (const [k, v] of lastSend) if (t - v > 60000) lastSend.delete(k); }, 60000).unref();

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function pidFrom(req) {
  const secret = String(req.headers['x-player'] || '');
  if (!/^[\w-]{8,64}$/.test(secret)) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 32); // public ID (hindi puwedeng gawing secret)
}
async function membership(pid) {
  const r = await q(
    `SELECT m.clan_id, m.role, c.name, c.tag, c.leader_id FROM mining_clan_members m
     JOIN mining_clans c ON c.id = m.clan_id WHERE m.player_id = $1`, [pid]);
  return r[0] || null;
}
async function cleanupOrphan(pid) {
  await q('DELETE FROM mining_clan_members WHERE player_id = $1 AND clan_id NOT IN (SELECT id FROM mining_clans)', [pid]);
}
async function profileName(pid) {
  const r = await q('SELECT name FROM mining_leaderboard WHERE player_id = $1', [pid]);
  return r[0] ? r[0].name : null;
}

// ---------- avatars (public/profile/*.png) ----------
const PROFILE_DIR = path.join(__dirname, 'public', 'profile');
let avCache = { t: 0, list: [] };
function avatarList() {
  const t = Date.now();
  if (t - avCache.t > 30000) {
    let list = [];
    try { list = fs.readdirSync(PROFILE_DIR).filter((f) => /\.png$/i.test(f) && f.length <= 80); } catch (e) {}
    list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    avCache = { t, list };
  }
  return avCache.list;
}

// ---------- routes ----------
const routes = {
  async '/api/profile'({ pid, body }) {
    const name = cleanText(body.name, 16);
    if (!NAME_RE.test(name)) throw bad('Pangalan: 3-16 characters (letters, numbers, space, _ o -).');
    const list = avatarList();
    let avatar = String(body.avatar || '');
    if (avatar && !list.includes(avatar)) throw bad('Maling avatar.');
    if (!avatar && list.length) {
      const cur = await q('SELECT avatar FROM mining_leaderboard WHERE player_id = $1', [pid]);
      if (!(cur[0] && cur[0].avatar)) throw bad('Pumili ng avatar.');
    }
    await q(`INSERT INTO mining_leaderboard (player_id, name, avatar) VALUES ($1, $2, $3)
             ON CONFLICT (player_id) DO UPDATE SET name = EXCLUDED.name,
               avatar = CASE WHEN EXCLUDED.avatar <> '' THEN EXCLUDED.avatar ELSE mining_leaderboard.avatar END,
               updated_at = now()`, [pid, name, avatar]);
    await q('UPDATE mining_clan_members SET name = $2 WHERE player_id = $1', [pid, name]);
    return { pid };
  },

  async '/api/avatars'() { return { list: avatarList() }; },

  async '/api/sync'({ pid, body }) {
    const name = cleanText(body.name, 16);
    if (!NAME_RE.test(name)) throw bad('Maling pangalan.');
    const xp = Number(body.xp), gold = Number(body.gold), rank = Number(body.rank), mines = Number(body.mines);
    if (![xp, gold, rank, mines].every(Number.isFinite) || xp < 0 || xp > 1e15 || gold < 0 || gold > 1e15) throw bad('Maling data.');
    await q(
      `INSERT INTO mining_leaderboard (player_id, name, xp, rank_idx, mines, gold_earned, updated_at)
       VALUES ($1, $2, $3::bigint, $4, $5, $6::bigint, now())
       ON CONFLICT (player_id) DO UPDATE SET
         name = EXCLUDED.name,
         xp = GREATEST(mining_leaderboard.xp, EXCLUDED.xp),
         rank_idx = GREATEST(mining_leaderboard.rank_idx, EXCLUDED.rank_idx),
         mines = EXCLUDED.mines,
         gold_earned = GREATEST(mining_leaderboard.gold_earned, EXCLUDED.gold_earned),
         updated_at = now()`,
      [pid, name, String(Math.floor(xp)), Math.max(0, Math.min(19, Math.floor(rank))), Math.max(0, Math.min(1000, Math.floor(mines))), String(Math.floor(gold))]);
    return { pid };
  },

  async '/api/leaderboard'({ pid }) {
    const [top, me, cnt] = await Promise.all([
      q('SELECT player_id AS pid, name, avatar, xp, rank_idx, mines FROM mining_leaderboard ORDER BY xp DESC, updated_at ASC LIMIT 50'),
      q('SELECT (SELECT count(*) FROM mining_leaderboard WHERE xp > m.xp) + 1 AS pos, m.name, m.avatar, m.xp, m.rank_idx, m.mines FROM mining_leaderboard m WHERE m.player_id = $1', [pid]),
      q('SELECT count(*) AS n FROM mining_leaderboard'),
    ]);
    return { pid, top, me: me[0] || null, total: Number(cnt[0] && cnt[0].n) || top.length };
  },

  // ----- chat -----
  async '/api/chat/list'({ pid, body }) {
    let chan = 'global';
    if (body.channel === 'clan') {
      const m = await membership(pid);
      if (!m) throw bad('Wala kang clan.');
      chan = 'clan:' + m.clan_id;
    }
    const after = Math.max(0, Math.floor(Number(body.after) || 0));
    let rows;
    if (!after) {
      rows = (await q(`SELECT c.id, c.player_id AS pid, c.name, c.tag, c.msg, c.created_at, COALESCE(l.avatar, '') AS avatar
        FROM mining_chat c LEFT JOIN mining_leaderboard l ON l.player_id = c.player_id WHERE c.channel = $1 ORDER BY c.id DESC LIMIT 50`, [chan])).reverse();
    } else {
      rows = await q(`SELECT c.id, c.player_id AS pid, c.name, c.tag, c.msg, c.created_at, COALESCE(l.avatar, '') AS avatar
        FROM mining_chat c LEFT JOIN mining_leaderboard l ON l.player_id = c.player_id WHERE c.channel = $1 AND c.id > $2::bigint ORDER BY c.id ASC LIMIT 100`, [chan, String(after)]);
    }
    return { rows };
  },

  async '/api/chat/send'({ pid, body }) {
    const msg = cleanText(body.msg, CHAT_MAX);
    if (!msg) throw bad('Walang laman ang message.');
    const t = Date.now();
    if (t - (lastSend.get(pid) || 0) < CHAT_COOLDOWN) throw new HttpError(429, 'Dahan-dahan sa pag-send.');
    const name = await profileName(pid);
    if (!name) throw bad('Gumawa muna ng profile.');
    const m = await membership(pid);
    let chan = 'global';
    if (body.channel === 'clan') {
      if (!m) throw bad('Wala kang clan.');
      chan = 'clan:' + m.clan_id;
    }
    lastSend.set(pid, t);
    await q('INSERT INTO mining_chat (channel, player_id, name, tag, msg) VALUES ($1, $2, $3, $4, $5)', [chan, pid, name, m ? m.tag : '', msg]);
    if (Math.random() < 0.03) q("DELETE FROM mining_chat WHERE created_at < now() - interval '7 days'").catch(() => {});
    return { ok: true };
  },

  // ----- clans -----
  async '/api/clan/me'({ pid }) {
    const m = await membership(pid);
    return { pid, clan: m ? { id: String(m.clan_id), name: m.name, tag: m.tag, leader_pid: m.leader_id } : null };
  },

  async '/api/clan/list'() {
    const rows = await q(
      `SELECT c.id, c.name, c.tag, count(m.player_id) AS n, COALESCE(sum(l.xp), 0) AS xp,
         (SELECT name FROM mining_clan_members WHERE clan_id = c.id AND role = 'leader' LIMIT 1) AS leader
       FROM mining_clans c LEFT JOIN mining_clan_members m ON m.clan_id = c.id
       LEFT JOIN mining_leaderboard l ON l.player_id = m.player_id
       GROUP BY c.id ORDER BY xp DESC, n DESC LIMIT 30`);
    return { rows };
  },

  async '/api/clan/members'({ pid }) {
    const m = await membership(pid);
    if (!m) throw bad('Wala kang clan.');
    const rows = await q(
      `SELECT m.player_id AS pid, m.role, COALESCE(l.name, NULLIF(m.name, ''), '?') AS name,
              COALESCE(l.xp, 0) AS xp, COALESCE(l.rank_idx, 0) AS rank_idx, COALESCE(l.avatar, '') AS avatar
       FROM mining_clan_members m LEFT JOIN mining_leaderboard l ON l.player_id = m.player_id
       WHERE m.clan_id = $1::bigint ORDER BY (m.role = 'leader') DESC, l.xp DESC NULLS LAST`, [String(m.clan_id)]);
    return { rows, max: CLAN_MAX };
  },

  async '/api/clan/create'({ pid, body }) {
    const name = cleanText(body.name, 16), tag = cleanText(body.tag, 4).toUpperCase();
    if (!NAME_RE.test(name)) throw bad('Pangalan: 3-16 characters (letters, numbers, space, _ o -).');
    if (!TAG_RE.test(tag)) throw bad('Tag: 2-4 letters/numbers.');
    const pname = await profileName(pid);
    if (!pname) throw bad('Gumawa muna ng profile.');
    await cleanupOrphan(pid);
    if (await membership(pid)) throw new HttpError(409, 'May clan ka na.');
    let id;
    try {
      const r = await q('INSERT INTO mining_clans (name, name_key, tag, leader_id) VALUES ($1, $2, $3, $4) RETURNING id', [name, name.toLowerCase(), tag, pid]);
      id = String(r[0].id);
    } catch (e) {
      if (/duplicate|unique/i.test(e.message)) throw new HttpError(409, 'May gumagamit na ng pangalan na iyan.');
      throw e;
    }
    try {
      await q("INSERT INTO mining_clan_members (player_id, clan_id, role, name) VALUES ($1, $2::bigint, 'leader', $3)", [pid, id, pname]);
    } catch (e) {
      await q('DELETE FROM mining_clans WHERE id = $1::bigint', [id]).catch(() => {});
      throw new HttpError(409, 'May clan ka na.');
    }
    return { ok: true };
  },

  async '/api/clan/join'({ pid, body }) {
    const id = String(Math.floor(Number(body.id)));
    if (!/^\d+$/.test(id)) throw bad('Maling clan.');
    if (!(await profileName(pid))) throw bad('Gumawa muna ng profile.');
    await cleanupOrphan(pid);
    if (await membership(pid)) throw new HttpError(409, 'May clan ka na.');
    const r = await q(
      `INSERT INTO mining_clan_members (player_id, clan_id, role, name)
       SELECT $1::text, $2::bigint, 'member'::text, COALESCE((SELECT name FROM mining_leaderboard WHERE player_id = $1), '')
       WHERE (SELECT count(*) FROM mining_clan_members WHERE clan_id = $2::bigint) < ${CLAN_MAX}
         AND EXISTS (SELECT 1 FROM mining_clans WHERE id = $2::bigint) RETURNING clan_id`, [pid, id]);
    if (!r.length) throw new HttpError(409, 'Puno na o wala na ang clan.');
    return { ok: true };
  },

  async '/api/clan/leave'({ pid }) {
    const m = await membership(pid);
    if (!m) return { ok: true };
    if (m.leader_id === pid) {
      const c = await q('SELECT count(*) AS n FROM mining_clan_members WHERE clan_id = $1::bigint', [String(m.clan_id)]);
      if (Number(c[0].n) > 1) throw bad('Leader ka. Ilipat muna ang leader sa iba, o i-disband.');
      await disband(pid, String(m.clan_id));
      return { ok: true };
    }
    await q('DELETE FROM mining_clan_members WHERE player_id = $1', [pid]);
    return { ok: true };
  },

  async '/api/clan/disband'({ pid }) {
    const m = await membership(pid);
    if (!m) throw bad('Wala kang clan.');
    if (m.leader_id !== pid) throw new HttpError(403, 'Leader lang ang puwede.');
    await disband(pid, String(m.clan_id));
    return { ok: true };
  },

  async '/api/clan/kick'({ pid, body }) {
    const m = await membership(pid);
    if (!m || m.leader_id !== pid) throw new HttpError(403, 'Leader lang ang puwede.');
    const target = String(body.pid || '');
    if (!/^[0-9a-f]{32}$/.test(target) || target === pid) throw bad('Maling target.');
    await q('DELETE FROM mining_clan_members WHERE player_id = $1 AND clan_id = $2::bigint', [target, String(m.clan_id)]);
    return { ok: true };
  },

  async '/api/clan/transfer'({ pid, body }) {
    const m = await membership(pid);
    if (!m || m.leader_id !== pid) throw new HttpError(403, 'Leader lang ang puwede.');
    const target = String(body.pid || '');
    if (!/^[0-9a-f]{32}$/.test(target) || target === pid) throw bad('Maling target.');
    const id = String(m.clan_id);
    const r = await q(
      `UPDATE mining_clans SET leader_id = $2 WHERE id = $3::bigint AND leader_id = $1
       AND EXISTS (SELECT 1 FROM mining_clan_members WHERE player_id = $2 AND clan_id = $3::bigint) RETURNING id`, [pid, target, id]);
    if (!r.length) throw bad('Hindi na member ang player na iyon.');
    await q("UPDATE mining_clan_members SET role = CASE WHEN player_id = $2 THEN 'leader' ELSE 'member' END WHERE clan_id = $1::bigint", [id, target]);
    return { ok: true };
  },
};

async function disband(pid, id) {
  await q('DELETE FROM mining_chat WHERE channel = $1', ['clan:' + id]);
  await q('DELETE FROM mining_clan_members WHERE clan_id = $1::bigint', [id]);
  await q('DELETE FROM mining_clans WHERE id = $1::bigint AND leader_id = $2', [id, pid]);
}

// ---------- server ----------
const INDEX = path.join(__dirname, 'public', 'index.html');
function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 10000) { reject(new HttpError(413, 'Masyadong malaki.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(bad('Maling JSON.')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(INDEX, 'utf8'));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/profile/')) {
      const f = decodeURIComponent(url.pathname.slice(9));
      if (!avatarList().includes(f)) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(path.join(PROFILE_DIR, f)).pipe(res);
    }
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    const handler = routes[url.pathname];
    if (!handler) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST lang' });

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const h = ipHits.get(ip) || { n: 0 }; h.n++; ipHits.set(ip, h);
    if (h.n > 240) throw new HttpError(429, 'Masyadong maraming request.');

    const pid = pidFrom(req);
    if (!pid && url.pathname !== '/api/clan/list' && url.pathname !== '/api/avatars') throw new HttpError(401, 'Walang player ID.');
    const body = await readBody(req);
    await ensure();
    send(res, 200, await handler({ pid, body, req }));
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});
server.listen(PORT, () => console.log('Mining Game server on :' + PORT));
