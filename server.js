'use strict';
// Mining Game server: static game + API (leaderboard, chat, teams, friends, admin).
// Walang npm dependencies. Kailangan: Node 18+ at env var DATABASE_URL (Neon connection string).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB = (process.env.DATABASE_URL || '').trim().replace(/^psql\s+/i, '').replace(/^['"]+|['"]+$/g, '').trim();
let NEON_URL = '';
try { if (DB) NEON_URL = 'https://' + new URL(DB.replace(/^postgres(?:ql)?:/, 'https:')).hostname + '/sql'; }
catch (e) { console.error('Invalid DATABASE_URL format.'); }
if (!NEON_URL) console.error('WARNING: DATABASE_URL is missing or invalid. Online features will not work.');

const CLAN_MAX = 30, CHAT_MAX = 140, CHAT_COOLDOWN = 1500;
const NAME_RE = /^[\p{L}\p{N} _-]{3,16}$/u;
const TAG_RE = /^[A-Z0-9]{2,4}$/;
const TAG_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // walang O/0/I/1 para hindi nakakalito
const MODES = ['open', 'private', 'closed']; // open = kahit sino | private = kailangan ng approval | closed = walang makakapasok
const REACTS = ['like', 'love', 'haha', 'wow', 'sad', 'fire'];
const ADMIN_CODE = String(process.env.ADMIN_CODE || ''); // sikreto ng admin panel (itakda sa env). Walang laman = naka-disable ang admin.
const ONLINE_SEC = 120; // active kung may request sa nakaraang 120s
const ONLINE_SQL = `(l.last_seen > now() - interval '${ONLINE_SEC} seconds')`;
// Team badge: icon + color + shape (whitelist para hindi makapasok ang kung anu-ano)
const BADGE_ICONS = ['trophy','star','pick','gem','bolt','flame','crystal','stone','iron','box','moon','r7','r8','r9','r13','r16','r18','r19','mt9','mt7'];
const BADGE_SHAPES = ['circle','square','hex'];
const BADGE_DEFAULT = { icon: 'trophy', color: '#ffc54a', shape: 'circle' };
function sanitizeBadge(b) {
  b = b && typeof b === 'object' ? b : {};
  const color = String(b.color || '').toLowerCase();
  return {
    icon: BADGE_ICONS.includes(b.icon) ? b.icon : BADGE_DEFAULT.icon,
    color: /^#[0-9a-f]{6}$/.test(color) ? color : BADGE_DEFAULT.color,
    shape: BADGE_SHAPES.includes(b.shape) ? b.shape : BADGE_DEFAULT.shape,
  };
}
const badgeOf = (r) => sanitizeBadge({ icon: r.badge_icon, color: r.badge_color, shape: r.badge_shape });
const isT = (v) => v === true || v === 't' || v === 'true';
const randomTag = () => { let t = ''; for (let i = 0; i < 4; i++) t += TAG_CHARS[crypto.randomInt(TAG_CHARS.length)]; return t; };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

// ---------- DB (Neon SQL-over-HTTP, mula sa server kaya walang CORS issue) ----------
async function q(query, params = []) {
  if (!NEON_URL) throw new HttpError(503, 'Database is not configured.');
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
      await q("ALTER TABLE mining_clans ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'open'");
      await q(`CREATE TABLE IF NOT EXISTS mining_clan_requests (
        player_id text PRIMARY KEY, clan_id bigint NOT NULL, name text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now())`);
      await q('CREATE INDEX IF NOT EXISTS mining_clan_requests_clan ON mining_clan_requests (clan_id)');
      await q("ALTER TABLE mining_chat ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'msg'"); // msg | join | leave | kick | rankup
      await q(`CREATE TABLE IF NOT EXISTS mining_reactions (
        msg_id bigint NOT NULL, player_id text NOT NULL, emoji text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (msg_id, player_id))`);
      // --- Player ID, presence, bans ---
      await q('ALTER TABLE mining_leaderboard ADD COLUMN IF NOT EXISTS uid bigserial');
      await q('CREATE UNIQUE INDEX IF NOT EXISTS mining_lb_uid ON mining_leaderboard (uid)');
      await q('ALTER TABLE mining_leaderboard ADD COLUMN IF NOT EXISTS last_seen timestamptz NOT NULL DEFAULT now()');
      await q('ALTER TABLE mining_leaderboard ADD COLUMN IF NOT EXISTS banned boolean NOT NULL DEFAULT false');
      await q('ALTER TABLE mining_leaderboard ADD COLUMN IF NOT EXISTS chat_banned boolean NOT NULL DEFAULT false');
      // --- Admin settings (announcement, chat on/off, bad words) ---
      await q('CREATE TABLE IF NOT EXISTS mining_settings (key text PRIMARY KEY, value text NOT NULL DEFAULT \'\')');
      // --- Friends + team invites ---
      await q(`CREATE TABLE IF NOT EXISTS mining_friends (
        a text NOT NULL, b text NOT NULL, status text NOT NULL DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (a, b))`);
      await q('CREATE INDEX IF NOT EXISTS mining_friends_b ON mining_friends (b)');
      await q(`CREATE TABLE IF NOT EXISTS mining_clan_invites (
        player_id text NOT NULL, clan_id bigint NOT NULL, from_name text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (player_id, clan_id))`);
      // --- Team badge ---
      await q("ALTER TABLE mining_clans ADD COLUMN IF NOT EXISTS badge_icon text NOT NULL DEFAULT ''");
      await q("ALTER TABLE mining_clans ADD COLUMN IF NOT EXISTS badge_color text NOT NULL DEFAULT ''");
      await q("ALTER TABLE mining_clans ADD COLUMN IF NOT EXISTS badge_shape text NOT NULL DEFAULT ''");
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
    `SELECT m.clan_id, m.role, c.name, c.tag, c.leader_id, c.mode, c.badge_icon, c.badge_color, c.badge_shape FROM mining_clan_members m
     JOIN mining_clans c ON c.id = m.clan_id WHERE m.player_id = $1`, [pid]);
  return r[0] || null;
}
async function cleanupOrphan(pid) {
  await q('DELETE FROM mining_clan_members WHERE player_id = $1 AND clan_id NOT IN (SELECT id FROM mining_clans)', [pid]);
}
// System message sa clan chat (join / leave / kick / rankup). Hindi dapat ito makasira sa mismong action.
async function sysMsg(clanId, pid, name, tag, kind, msg) {
  try {
    await q('INSERT INTO mining_chat (channel, player_id, name, tag, msg, kind) VALUES ($1, $2, $3, $4, $5, $6)',
      ['clan:' + clanId, pid, name || '?', tag || '', msg || '', kind]);
  } catch (e) { console.error('sysMsg failed:', e.message); }
}
async function profileName(pid) {
  const r = await q('SELECT name FROM mining_leaderboard WHERE player_id = $1', [pid]);
  return r[0] ? r[0].name : null;
}

// ---------- settings (announcement / chat on-off / bad words) ----------
let settingsCache = { t: 0, v: null };
async function getSettings(force) {
  const t = Date.now();
  if (!force && settingsCache.v && t - settingsCache.t < 8000) return settingsCache.v;
  const rows = await q('SELECT key, value FROM mining_settings');
  const m = {}; rows.forEach((r) => { m[r.key] = r.value; });
  let ann = null;
  try { ann = m.announcement ? JSON.parse(m.announcement) : null; } catch (e) {}
  const v = {
    announcement: ann && ann.text ? ann : null,        // { id, text }
    chat_on: m.chat_on !== '0',
    badwords: String(m.badwords || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 500),
  };
  settingsCache = { t, v };
  return v;
}
async function setSetting(key, value) {
  await q('INSERT INTO mining_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  settingsCache = { t: 0, v: null };
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let bwCache = { src: '', re: null };
function censor(text, words) {
  if (!words.length) return text;
  const src = words.join('\n');
  if (bwCache.src !== src) {
    const parts = words.slice().sort((a, b) => b.length - a.length).map(escRe);
    bwCache = { src, re: new RegExp('(' + parts.join('|') + ')', 'giu') };
  }
  return text.replace(bwCache.re, (m) => '*'.repeat(m.length));
}

// ---------- presence + ban cache ----------
const seenAt = new Map();     // pid -> ms (huling DB update)
const banCache = new Map();   // pid -> { t, banned }
setInterval(() => { const t = Date.now(); for (const [k, v] of seenAt) if (t - v > 300000) seenAt.delete(k); for (const [k, v] of banCache) if (t - v.t > 60000) banCache.delete(k); }, 60000).unref();
async function isBanned(pid) {
  const c = banCache.get(pid), t = Date.now();
  if (c && t - c.t < 10000) return c.banned;
  const r = await q('SELECT banned FROM mining_leaderboard WHERE player_id = $1', [pid]);
  const banned = !!(r[0] && isT(r[0].banned));
  banCache.set(pid, { t, banned });
  return banned;
}
function touch(pid) {
  const t = Date.now();
  if (t - (seenAt.get(pid) || 0) < 25000) return;
  seenAt.set(pid, t);
  q('UPDATE mining_leaderboard SET last_seen = now() WHERE player_id = $1', [pid]).catch(() => {});
}

// ---------- players / friends ----------
// Hanapin ang player gamit ang numeric ID (uid), 32-char pid, o eksaktong pangalan.
async function findPlayer(s) {
  s = String(s || '').trim().replace(/^#/, '');
  if (!s) throw bad('Enter a player ID or name.');
  let r;
  if (/^\d{1,12}$/.test(s)) r = await q('SELECT player_id AS pid, uid, name, banned, chat_banned FROM mining_leaderboard WHERE uid = $1::bigint', [s]);
  else if (/^[0-9a-f]{32}$/.test(s)) r = await q('SELECT player_id AS pid, uid, name, banned, chat_banned FROM mining_leaderboard WHERE player_id = $1', [s]);
  else r = await q('SELECT player_id AS pid, uid, name, banned, chat_banned FROM mining_leaderboard WHERE lower(name) = lower($1) LIMIT 3', [s]);
  if (!r.length) throw new HttpError(404, 'Player not found.');
  if (r.length > 1) throw bad('More than one player has that name. Use the player ID instead.');
  return r[0];
}
async function friendStatus(a, b) { // relasyon ng a kay b
  const r = await q('SELECT a, status FROM mining_friends WHERE (a = $1 AND b = $2) OR (a = $2 AND b = $1)', [a, b]);
  if (!r.length) return 'none';
  const x = r[0];
  if (x.status === 'accepted') return 'friend';
  return x.a === a ? 'outgoing' : 'incoming';
}
const dmChan = (a, b) => 'dm:' + [a, b].sort().join(':');
async function requireFriend(pid, peer) {
  if (!/^[0-9a-f]{32}$/.test(String(peer || '')) || peer === pid) throw bad('Invalid friend.');
  if ((await friendStatus(pid, peer)) !== 'friend') throw new HttpError(403, 'You can only private chat with friends.');
  return dmChan(pid, peer);
}
function requireAdmin(req) {
  const given = String(req.headers['x-admin'] || '');
  if (!ADMIN_CODE) throw new HttpError(503, 'Admin is disabled. Set the ADMIN_CODE environment variable on the server.');
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(ADMIN_CODE).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'Wrong admin password.');
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
    if (!NAME_RE.test(name)) throw bad('Name: 3-16 characters (letters, numbers, space, _ or -).');
    const list = avatarList();
    let avatar = String(body.avatar || '');
    if (avatar && !list.includes(avatar)) throw bad('Invalid avatar.');
    if (!avatar && list.length) {
      const cur = await q('SELECT avatar FROM mining_leaderboard WHERE player_id = $1', [pid]);
      if (!(cur[0] && cur[0].avatar)) throw bad('Pick an avatar.');
    }
    await q(`INSERT INTO mining_leaderboard (player_id, name, avatar) VALUES ($1, $2, $3)
             ON CONFLICT (player_id) DO UPDATE SET name = EXCLUDED.name,
               avatar = CASE WHEN EXCLUDED.avatar <> '' THEN EXCLUDED.avatar ELSE mining_leaderboard.avatar END,
               updated_at = now()`, [pid, name, avatar]);
    await q('UPDATE mining_clan_members SET name = $2 WHERE player_id = $1', [pid, name]);
    return { pid };
  },

  async '/api/avatars'() { return { list: avatarList() }; },

  // Profile ng player (sarili kung walang body.pid)
  async '/api/player'({ pid, body }) {
    const target = body.pid ? String(body.pid) : pid;
    if (!/^[0-9a-f]{32}$/.test(target)) throw bad('Invalid player.');
    const r = await q(
      `SELECT l.player_id AS pid, l.uid, ${ONLINE_SQL} AS online, l.name, l.avatar, l.xp, l.rank_idx, l.mines, l.gold_earned,
              (SELECT count(*) FROM mining_leaderboard WHERE xp > l.xp) + 1 AS pos,
              (SELECT count(*) FROM mining_leaderboard) AS total,
              c.name AS clan_name, c.tag AS clan_tag, m.role AS clan_role, c.badge_icon, c.badge_color, c.badge_shape
       FROM mining_leaderboard l
       LEFT JOIN mining_clan_members m ON m.player_id = l.player_id
       LEFT JOIN mining_clans c ON c.id = m.clan_id
       WHERE l.player_id = $1`, [target]);
    if (!r[0]) throw new HttpError(404, 'That player has no profile.');
    const p = r[0];
    const me = target === pid;
    const rel = me ? 'me' : await friendStatus(pid, target);
    return { me, total: Number(p.total) || 0, rel, player: {
      pid: p.pid, uid: Number(p.uid), online: isT(p.online) || me, name: p.name, avatar: p.avatar, xp: Number(p.xp), rank_idx: Number(p.rank_idx), mines: Number(p.mines),
      gold_earned: Number(p.gold_earned), pos: Number(p.pos),
      clan: p.clan_tag ? { name: p.clan_name, tag: p.clan_tag, role: p.clan_role, badge: badgeOf(p) } : null } };
  },

  async '/api/sync'({ pid, body }) {
    const name = cleanText(body.name, 16);
    if (!NAME_RE.test(name)) throw bad('Invalid name.');
    const xp = Number(body.xp), gold = Number(body.gold), rank = Number(body.rank), mines = Number(body.mines);
    if (![xp, gold, rank, mines].every(Number.isFinite) || xp < 0 || xp > 1e15 || gold < 0 || gold > 1e15) throw bad('Invalid data.');
    const prev = await q('SELECT rank_idx FROM mining_leaderboard WHERE player_id = $1', [pid]);
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
    // Rank up -> i-announce sa clan chat (kung may clan)
    const newRank = Math.max(0, Math.min(19, Math.floor(rank)));
    if (prev[0] && newRank > Number(prev[0].rank_idx)) {
      const m = await membership(pid).catch(() => null);
      if (m) await sysMsg(m.clan_id, pid, name, m.tag, 'rankup', String(newRank));
    }
    return { pid };
  },

  async '/api/leaderboard'({ pid }) {
    const [top, me, cnt] = await Promise.all([
      q(`SELECT l.player_id AS pid, l.name, l.avatar, l.xp, l.rank_idx, l.mines, ${ONLINE_SQL} AS online
         FROM mining_leaderboard l WHERE NOT l.banned ORDER BY l.xp DESC, l.updated_at ASC LIMIT 50`),
      q('SELECT (SELECT count(*) FROM mining_leaderboard WHERE xp > m.xp) + 1 AS pos, m.name, m.avatar, m.xp, m.rank_idx, m.mines FROM mining_leaderboard m WHERE m.player_id = $1', [pid]),
      q('SELECT count(*) AS n FROM mining_leaderboard'),
    ]);
    top.forEach((p) => { p.online = isT(p.online); });
    return { pid, top, me: me[0] || null, total: Number(cnt[0] && cnt[0].n) || top.length };
  },

  // ----- chat -----
  async '/api/chat/list'({ pid, body }) {
    let chan = 'global';
    if (body.channel === 'clan') {
      const m = await membership(pid);
      if (!m) throw bad('You are not in a team.');
      chan = 'clan:' + m.clan_id;
    } else if (body.channel === 'dm') {
      chan = await requireFriend(pid, String(body.peer || ''));
    }
    const after = Math.max(0, Math.floor(Number(body.after) || 0));
    const since = Math.max(0, Math.floor(Number(body.since) || 0));
    const COLS = `c.id, c.player_id AS pid, c.name, c.tag, c.msg, c.kind, c.created_at, COALESCE(l.avatar, '') AS avatar, COALESCE(${ONLINE_SQL}, false) AS online`;
    let rows;
    if (!after) {
      rows = (await q(`SELECT ${COLS}
        FROM mining_chat c LEFT JOIN mining_leaderboard l ON l.player_id = c.player_id WHERE c.channel = $1 ORDER BY c.id DESC LIMIT 50`, [chan])).reverse();
    } else {
      rows = await q(`SELECT ${COLS}
        FROM mining_chat c LEFT JOIN mining_leaderboard l ON l.player_id = c.player_id WHERE c.channel = $1 AND c.id > $2::bigint ORDER BY c.id ASC LIMIT 100`, [chan, String(after)]);
    }
    // Reactions ng lahat ng messages na hawak ng client (mula 'since'), para ma-update din ang luma.
    const from = after ? (since || after) : (rows.length ? Number(rows[0].id) : 0);
    const reactions = {};
    if (from) {
      const rr = await q(
        `SELECT r.msg_id, r.emoji, count(*) AS n, bool_or(r.player_id = $3) AS mine
         FROM mining_reactions r JOIN mining_chat c ON c.id = r.msg_id
         WHERE c.channel = $1 AND c.id >= $2::bigint GROUP BY r.msg_id, r.emoji`, [chan, String(from), pid]);
      for (const x of rr) {
        (reactions[x.msg_id] = reactions[x.msg_id] || []).push({ e: x.emoji, n: Number(x.n), mine: x.mine === true || x.mine === 't' });
      }
      for (const k in reactions) reactions[k].sort((a, b) => REACTS.indexOf(a.e) - REACTS.indexOf(b.e));
    }
    rows.forEach((x) => { x.online = isT(x.online); });
    return { rows, reactions };
  },

  async '/api/chat/react'({ pid, body }) {
    const id = String(Math.floor(Number(body.id)));
    const e = String(body.e || '');
    if (!/^\d+$/.test(id)) throw bad('Invalid message.');
    if (!REACTS.includes(e)) throw bad('Invalid reaction.');
    if (!(await profileName(pid))) throw bad('Create a profile first.');
    const r = await q('SELECT channel, kind FROM mining_chat WHERE id = $1::bigint', [id]);
    if (!r[0]) throw bad('That message no longer exists.');
    if (r[0].kind !== 'msg' && r[0].kind !== 'rankup') throw bad('You cannot react to this.');
    if (r[0].channel.startsWith('dm:')) {
      const parts = r[0].channel.split(':');
      if (!parts.includes(pid)) throw new HttpError(403, 'You cannot react to this.');
    } else if (r[0].channel !== 'global') {
      const m = await membership(pid);
      if (!m || r[0].channel !== 'clan:' + m.clan_id) throw new HttpError(403, 'You cannot react to this.');
    }
    // Isang reaction kada player kada message: ulitin ang parehong emoji = tanggal, ibang emoji = palit.
    const cur = await q('SELECT emoji FROM mining_reactions WHERE msg_id = $1::bigint AND player_id = $2', [id, pid]);
    if (cur[0] && cur[0].emoji === e) {
      await q('DELETE FROM mining_reactions WHERE msg_id = $1::bigint AND player_id = $2', [id, pid]);
      return { ok: true, on: false };
    }
    await q(`INSERT INTO mining_reactions (msg_id, player_id, emoji) VALUES ($1::bigint, $2, $3)
             ON CONFLICT (msg_id, player_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`, [id, pid, e]);
    return { ok: true, on: true };
  },

  async '/api/chat/send'({ pid, body }) {
    let msg = cleanText(body.msg, CHAT_MAX);
    if (!msg) throw bad('Message is empty.');
    const t = Date.now();
    if (t - (lastSend.get(pid) || 0) < CHAT_COOLDOWN) throw new HttpError(429, 'Slow down.');
    const me = await q('SELECT name, chat_banned FROM mining_leaderboard WHERE player_id = $1', [pid]);
    if (!me[0]) throw bad('Create a profile first.');
    const name = me[0].name;
    const m = await membership(pid);
    let chan = 'global';
    if (body.channel === 'clan') {
      if (!m) throw bad('You are not in a team.');
      chan = 'clan:' + m.clan_id;
    } else if (body.channel === 'dm') {
      chan = await requireFriend(pid, String(body.peer || ''));
    }
    const st = await getSettings();
    if (chan === 'global') {
      if (!st.chat_on) throw new HttpError(403, 'Global chat is turned off right now.');
      if (isT(me[0].chat_banned)) throw new HttpError(403, 'You are banned from the global chat.');
    }
    msg = censor(msg, st.badwords);
    lastSend.set(pid, t);
    await q('INSERT INTO mining_chat (channel, player_id, name, tag, msg) VALUES ($1, $2, $3, $4, $5)', [chan, pid, name, m ? m.tag : '', msg]);
    if (Math.random() < 0.03) {
      q("DELETE FROM mining_chat WHERE created_at < now() - interval '7 days'")
        .then(() => q('DELETE FROM mining_reactions r WHERE NOT EXISTS (SELECT 1 FROM mining_chat c WHERE c.id = r.msg_id)'))
        .catch(() => {});
    }
    return { ok: true };
  },

  // ----- clans -----
  async '/api/clan/me'({ pid }) {
    const m = await membership(pid);
    return { pid, clan: m ? { id: String(m.clan_id), name: m.name, tag: m.tag, leader_pid: m.leader_id, mode: m.mode, badge: badgeOf(m) } : null };
  },

  async '/api/clan/list'({ pid, body }) {
    const qs = String((body && body.q) || '').trim().replace(/^\$/, '').slice(0, 16).replace(/[\\%_]/g, (c) => '\\' + c);
    const rows = await q(
      `SELECT c.id, c.name, c.tag, c.mode, c.badge_icon, c.badge_color, c.badge_shape, count(m.player_id) AS n, COALESCE(sum(l.xp), 0) AS xp,
         (SELECT name FROM mining_clan_members WHERE clan_id = c.id AND role = 'leader' LIMIT 1) AS leader
       FROM mining_clans c LEFT JOIN mining_clan_members m ON m.clan_id = c.id
       LEFT JOIN mining_leaderboard l ON l.player_id = m.player_id
       WHERE ($1::text = '' OR c.name ILIKE '%' || $1::text || '%' OR c.tag ILIKE $1::text || '%')
       GROUP BY c.id ORDER BY xp DESC, n DESC LIMIT 30`, [qs]);
    let pending = null; // clan na pinag-request-an ng player (kung meron)
    if (pid) {
      const r = await q('SELECT clan_id FROM mining_clan_requests WHERE player_id = $1', [pid]);
      if (r[0]) pending = String(r[0].clan_id);
    }
    rows.forEach((r) => { r.badge = badgeOf(r); delete r.badge_icon; delete r.badge_color; delete r.badge_shape; });
    return { rows, pending };
  },

  async '/api/clan/members'({ pid }) {
    const m = await membership(pid);
    if (!m) throw bad('You are not in a team.');
    const rows = await q(
      `SELECT m.player_id AS pid, m.role, COALESCE(l.name, NULLIF(m.name, ''), '?') AS name,
              COALESCE(l.xp, 0) AS xp, COALESCE(l.rank_idx, 0) AS rank_idx, COALESCE(l.avatar, '') AS avatar,
              COALESCE(${ONLINE_SQL}, false) AS online
       FROM mining_clan_members m LEFT JOIN mining_leaderboard l ON l.player_id = m.player_id
       WHERE m.clan_id = $1::bigint ORDER BY (m.role = 'leader') DESC, l.xp DESC NULLS LAST`, [String(m.clan_id)]);
    let requests = [];
    if (m.leader_id === pid) {
      requests = await q(
        `SELECT r.player_id AS pid, COALESCE(l.name, NULLIF(r.name, ''), '?') AS name, COALESCE(l.avatar, '') AS avatar,
                COALESCE(l.xp, 0) AS xp, COALESCE(l.rank_idx, 0) AS rank_idx
         FROM mining_clan_requests r LEFT JOIN mining_leaderboard l ON l.player_id = r.player_id
         WHERE r.clan_id = $1::bigint ORDER BY r.created_at ASC LIMIT 50`, [String(m.clan_id)]);
    }
    rows.forEach((x) => { x.online = isT(x.online); });
    return { rows, max: CLAN_MAX, mode: m.mode, requests };
  },

  async '/api/clan/create'({ pid, body }) {
    const name = cleanText(body.name, 16);
    if (!NAME_RE.test(name)) throw bad('Name: 3-16 characters (letters, numbers, space, _ or -).');
    const mode = MODES.includes(body.mode) ? body.mode : 'open';
    const bd = sanitizeBadge(body.badge);
    const pname = await profileName(pid);
    if (!pname) throw bad('Create a profile first.');
    await cleanupOrphan(pid);
    if (await membership(pid)) throw new HttpError(409, 'You are already in a team.');
    // Random na tag (4 chars). Sinisigurong walang ibang clan na may parehong tag.
    let id = null, tag = '';
    for (let i = 0; i < 10 && !id; i++) {
      tag = randomTag();
      try {
        const r = await q(
          `INSERT INTO mining_clans (name, name_key, tag, leader_id, mode, badge_icon, badge_color, badge_shape)
           SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text
           WHERE NOT EXISTS (SELECT 1 FROM mining_clans WHERE tag = $3::text) RETURNING id`,
          [name, name.toLowerCase(), tag, pid, mode, bd.icon, bd.color, bd.shape]);
        if (r.length) id = String(r[0].id);
      } catch (e) {
        if (/duplicate|unique/i.test(e.message)) throw new HttpError(409, 'That name is already taken.');
        throw e;
      }
    }
    if (!id) throw new HttpError(503, 'Could not generate a tag right now. Try again.');
    try {
      await q("INSERT INTO mining_clan_members (player_id, clan_id, role, name) VALUES ($1, $2::bigint, 'leader', $3)", [pid, id, pname]);
    } catch (e) {
      await q('DELETE FROM mining_clans WHERE id = $1::bigint', [id]).catch(() => {});
      throw new HttpError(409, 'You are already in a team.');
    }
    await q('DELETE FROM mining_clan_requests WHERE player_id = $1', [pid]).catch(() => {});
    return { ok: true, tag };
  },

  async '/api/clan/join'({ pid, body }) {
    const id = String(Math.floor(Number(body.id)));
    if (!/^\d+$/.test(id)) throw bad('Invalid team.');
    const pname = await profileName(pid);
    if (!pname) throw bad('Create a profile first.');
    await cleanupOrphan(pid);
    if (await membership(pid)) throw new HttpError(409, 'You are already in a team.');
    const c = await q('SELECT mode FROM mining_clans WHERE id = $1::bigint', [id]);
    if (!c[0]) throw new HttpError(409, 'That team no longer exists.');
    if (c[0].mode === 'closed') throw new HttpError(403, 'This team is closed and is not accepting new members.');
    if (c[0].mode === 'private') {
      const n = await q('SELECT count(*) AS n FROM mining_clan_members WHERE clan_id = $1::bigint', [id]);
      if (Number(n[0].n) >= CLAN_MAX) throw new HttpError(409, 'The team is full.');
      // Isang pending request lang kada player: papalitan ang dati.
      await q(`INSERT INTO mining_clan_requests (player_id, clan_id, name) VALUES ($1, $2::bigint, $3)
               ON CONFLICT (player_id) DO UPDATE SET clan_id = EXCLUDED.clan_id, name = EXCLUDED.name, created_at = now()`, [pid, id, pname]);
      return { ok: true, pending: true };
    }
    const r = await q(
      `INSERT INTO mining_clan_members (player_id, clan_id, role, name)
       SELECT $1::text, $2::bigint, 'member'::text, COALESCE((SELECT name FROM mining_leaderboard WHERE player_id = $1), '')
       WHERE (SELECT count(*) FROM mining_clan_members WHERE clan_id = $2::bigint) < ${CLAN_MAX}
         AND EXISTS (SELECT 1 FROM mining_clans WHERE id = $2::bigint) RETURNING clan_id`, [pid, id]);
    if (!r.length) throw new HttpError(409, 'The team is full or no longer exists.');
    await q('DELETE FROM mining_clan_requests WHERE player_id = $1', [pid]).catch(() => {});
    const m = await membership(pid).catch(() => null);
    if (m) await sysMsg(m.clan_id, pid, pname, m.tag, 'join', '');
    return { ok: true };
  },

  async '/api/clan/cancel'({ pid }) {
    await q('DELETE FROM mining_clan_requests WHERE player_id = $1', [pid]);
    return { ok: true };
  },

  // Leader: i-set ang privacy ng clan (open / private / closed)
  async '/api/clan/mode'({ pid, body }) {
    const m = await membership(pid);
    if (!m || m.leader_id !== pid) throw new HttpError(403, 'Only the Leader can do this.');
    const mode = String(body.mode || '');
    if (!MODES.includes(mode)) throw bad('Invalid mode.');
    await q('UPDATE mining_clans SET mode = $2 WHERE id = $1::bigint', [String(m.clan_id), mode]);
    if (mode === 'closed') await q('DELETE FROM mining_clan_requests WHERE clan_id = $1::bigint', [String(m.clan_id)]); // sarado na, walang approval
    return { ok: true, mode };
  },

  // Leader: i-approve ang request
  async '/api/clan/approve'({ pid, body }) {
    const m = await membership(pid);
    if (!m || m.leader_id !== pid) throw new HttpError(403, 'Only the Leader can do this.');
    const target = String(body.pid || '');
    if (!/^[0-9a-f]{32}$/.test(target) || target === pid) throw bad('Invalid target.');
    const id = String(m.clan_id);
    const req = await q('SELECT 1 FROM mining_clan_requests WHERE player_id = $1 AND clan_id = $2::bigint', [target, id]);
    if (!req.length) throw bad('That player has no pending request.');
    await cleanupOrphan(target);
    if (await membership(target)) {
      await q('DELETE FROM mining_clan_requests WHERE player_id = $1', [target]);
      throw new HttpError(409, 'That player is already in another team.');
    }
    const r = await q(
      `INSERT INTO mining_clan_members (player_id, clan_id, role, name)
       SELECT $1::text, $2::bigint, 'member'::text, COALESCE((SELECT name FROM mining_leaderboard WHERE player_id = $1), '')
       WHERE (SELECT count(*) FROM mining_clan_members WHERE clan_id = $2::bigint) < ${CLAN_MAX} RETURNING clan_id`, [target, id]);
    if (!r.length) throw new HttpError(409, 'The team is full.');
    await q('DELETE FROM mining_clan_requests WHERE player_id = $1', [target]);
    await sysMsg(id, target, (await profileName(target)) || '?', m.tag, 'join', '');
    return { ok: true };
  },

  async '/api/clan/reject'({ pid, body }) {
    const m = await membership(pid);
    if (!m || m.leader_id !== pid) throw new HttpError(403, 'Only the Leader can do this.');
    const target = String(body.pid || '');
    if (!/^[0-9a-f]{32}$/.test(target)) throw bad('Invalid target.');
    await q('DELETE FROM mining_clan_requests WHERE player_id = $1 AND clan_id = $2::bigint', [target, String(m.clan_id)]);
    return { ok: true };
  },

  async '/api/clan/leave'({ pid }) {
    const m = await membership(pid);
    if (!m) return { ok: true };
    if (m.leader_id === pid) {
      const c = await q('SELECT count(*) AS n FROM mining_clan_members WHERE clan_id = $1::bigint', [String(m.clan_id)]);
      if (Number(c[0].n) > 1) throw bad('You are the Leader. Transfer leadership first, or disband.');
      await disband(pid, String(m.clan_id));
      return { ok: true };
    }
    await q('DELETE FROM mining_clan_members WHERE player_id = $1', [pid]);
    await sysMsg(m.clan_id, pid, await profileName(pid), m.tag, 'leave', '');
    return { ok: true };
  },

  async '/api/clan/disband'({ pid }) {
    const m = await membership(pid);
    if (!m) throw bad('You are not in a team.');
    if (m.leader_id !== pid) throw new HttpError(403, 'Only the Leader can do this.');
    await disband(pid, String(m.clan_id));
    return { ok: true };
  },

  async '/api/clan/kick'({ pid, body }) {
    const m = await membership(pid);
    if (!m || m.leader_id !== pid) throw new HttpError(403, 'Only the Leader can do this.');
    const target = String(body.pid || '');
    if (!/^[0-9a-f]{32}$/.test(target) || target === pid) throw bad('Invalid target.');
    const gone = await q('DELETE FROM mining_clan_members WHERE player_id = $1 AND clan_id = $2::bigint RETURNING name', [target, String(m.clan_id)]);
    if (!gone.length) throw bad('That player is no longer a member.');
    const tname = (await profileName(target)) || gone[0].name || '?';
    await sysMsg(m.clan_id, target, tname, m.tag, 'kick', (await profileName(pid)) || '');
    return { ok: true };
  },

  async '/api/clan/transfer'({ pid, body }) {
    const m = await membership(pid);
    if (!m || m.leader_id !== pid) throw new HttpError(403, 'Only the Leader can do this.');
    const target = String(body.pid || '');
    if (!/^[0-9a-f]{32}$/.test(target) || target === pid) throw bad('Invalid target.');
    const id = String(m.clan_id);
    const r = await q(
      `UPDATE mining_clans SET leader_id = $2 WHERE id = $3::bigint AND leader_id = $1
       AND EXISTS (SELECT 1 FROM mining_clan_members WHERE player_id = $2 AND clan_id = $3::bigint) RETURNING id`, [pid, target, id]);
    if (!r.length) throw bad('That player is no longer a member.');
    await q("UPDATE mining_clan_members SET role = CASE WHEN player_id = $2 THEN 'leader' ELSE 'member' END WHERE clan_id = $1::bigint", [id, target]);
    return { ok: true };
  },

  // Leader: i-customize ang badge ng team
  async '/api/clan/badge'({ pid, body }) {
    const m = await membership(pid);
    if (!m || m.leader_id !== pid) throw new HttpError(403, 'Only the Leader can do this.');
    const bd = sanitizeBadge(body);
    await q('UPDATE mining_clans SET badge_icon = $2, badge_color = $3, badge_shape = $4 WHERE id = $1::bigint', [String(m.clan_id), bd.icon, bd.color, bd.shape]);
    return { ok: true, badge: bd };
  },

  // ----- team invites -----
  async '/api/clan/invite'({ pid, body }) {
    const m = await membership(pid);
    if (!m) throw bad('You are not in a team.');
    if (m.mode === 'closed' && m.leader_id !== pid) throw new HttpError(403, 'This team is closed. Only the Leader can invite.');
    const target = String(body.pid || '');
    if (!/^[0-9a-f]{32}$/.test(target) || target === pid) throw bad('Invalid player.');
    if (!(await profileName(target))) throw new HttpError(404, 'That player has no profile.');
    await cleanupOrphan(target);
    if (await membership(target)) throw new HttpError(409, 'That player is already in a team.');
    const n = await q('SELECT count(*) AS n FROM mining_clan_members WHERE clan_id = $1::bigint', [String(m.clan_id)]);
    if (Number(n[0].n) >= CLAN_MAX) throw new HttpError(409, 'The team is full.');
    const from = (await profileName(pid)) || '?';
    await q(`INSERT INTO mining_clan_invites (player_id, clan_id, from_name) VALUES ($1, $2::bigint, $3)
             ON CONFLICT (player_id, clan_id) DO UPDATE SET from_name = EXCLUDED.from_name, created_at = now()`, [target, String(m.clan_id), from]);
    return { ok: true };
  },

  async '/api/clan/invites'({ pid }) {
    await q("DELETE FROM mining_clan_invites WHERE created_at < now() - interval '3 days'").catch(() => {});
    if (await membership(pid)) return { rows: [] };
    const rows = await q(
      `SELECT i.clan_id AS id, c.name, c.tag, c.mode, c.badge_icon, c.badge_color, c.badge_shape, i.from_name,
              (SELECT count(*) FROM mining_clan_members WHERE clan_id = i.clan_id) AS n
       FROM mining_clan_invites i JOIN mining_clans c ON c.id = i.clan_id
       WHERE i.player_id = $1 ORDER BY i.created_at DESC LIMIT 20`, [pid]);
    return { rows: rows.map((r) => ({ id: String(r.id), name: r.name, tag: r.tag, from: r.from_name, n: Number(r.n), badge: badgeOf(r) })) };
  },

  async '/api/clan/invite/accept'({ pid, body }) {
    const id = String(Math.floor(Number(body.id)));
    if (!/^\d+$/.test(id)) throw bad('Invalid team.');
    const pname = await profileName(pid);
    if (!pname) throw bad('Create a profile first.');
    await cleanupOrphan(pid);
    if (await membership(pid)) throw new HttpError(409, 'You are already in a team.');
    const inv = await q('SELECT 1 FROM mining_clan_invites WHERE player_id = $1 AND clan_id = $2::bigint', [pid, id]);
    if (!inv.length) throw bad('That invite no longer exists.');
    const r = await q(
      `INSERT INTO mining_clan_members (player_id, clan_id, role, name)
       SELECT $1::text, $2::bigint, 'member'::text, $3::text
       WHERE (SELECT count(*) FROM mining_clan_members WHERE clan_id = $2::bigint) < ${CLAN_MAX}
         AND EXISTS (SELECT 1 FROM mining_clans WHERE id = $2::bigint) RETURNING clan_id`, [pid, id, pname]);
    if (!r.length) throw new HttpError(409, 'The team is full or no longer exists.');
    await q('DELETE FROM mining_clan_invites WHERE player_id = $1', [pid]).catch(() => {});
    await q('DELETE FROM mining_clan_requests WHERE player_id = $1', [pid]).catch(() => {});
    const m = await membership(pid).catch(() => null);
    if (m) await sysMsg(m.clan_id, pid, pname, m.tag, 'join', '');
    return { ok: true };
  },

  async '/api/clan/invite/decline'({ pid, body }) {
    const id = String(Math.floor(Number(body.id)));
    if (!/^\d+$/.test(id)) throw bad('Invalid team.');
    await q('DELETE FROM mining_clan_invites WHERE player_id = $1 AND clan_id = $2::bigint', [pid, id]);
    return { ok: true };
  },

  // ----- presence / announcement poll -----
  async '/api/ping'({ pid }) {
    const st = await getSettings();
    const [fr, inv] = await Promise.all([
      q("SELECT count(*) AS n FROM mining_friends WHERE b = $1 AND status = 'pending'", [pid]),
      q('SELECT count(*) AS n FROM mining_clan_invites WHERE player_id = $1', [pid]),
    ]);
    return { announcement: st.announcement, chat_on: st.chat_on, friend_reqs: Number(fr[0].n), invites: Number(inv[0].n) };
  },

  // ----- friends -----
  async '/api/friend/add'({ pid, body }) {
    const target = body.target ? (await findPlayer(body.target)).pid : String(body.pid || '');
    if (!/^[0-9a-f]{32}$/.test(target) || target === pid) throw bad('Invalid player.');
    if (!(await profileName(pid))) throw bad('Create a profile first.');
    if (!(await profileName(target))) throw new HttpError(404, 'That player has no profile.');
    const st = await friendStatus(pid, target);
    if (st === 'friend') throw new HttpError(409, 'You are already friends.');
    if (st === 'outgoing') return { ok: true, rel: 'outgoing' };
    if (st === 'incoming') {
      await q("UPDATE mining_friends SET status = 'accepted' WHERE a = $1 AND b = $2", [target, pid]);
      return { ok: true, rel: 'friend' };
    }
    const cnt = await q('SELECT count(*) AS n FROM mining_friends WHERE a = $1 OR b = $1', [pid]);
    if (Number(cnt[0].n) >= 200) throw bad('Your friend list is full.');
    await q('INSERT INTO mining_friends (a, b) VALUES ($1, $2) ON CONFLICT DO NOTHING', [pid, target]);
    return { ok: true, rel: 'outgoing' };
  },

  async '/api/friend/respond'({ pid, body }) {
    const target = String(body.pid || '');
    if (!/^[0-9a-f]{32}$/.test(target) || target === pid) throw bad('Invalid player.');
    if (body.accept) {
      const r = await q("UPDATE mining_friends SET status = 'accepted' WHERE a = $1 AND b = $2 AND status = 'pending' RETURNING a", [target, pid]);
      if (!r.length) throw bad('That request no longer exists.');
    } else {
      await q("DELETE FROM mining_friends WHERE a = $1 AND b = $2 AND status = 'pending'", [target, pid]);
    }
    return { ok: true };
  },

  // Unfriend, o i-cancel ang request na ipinadala mo
  async '/api/friend/remove'({ pid, body }) {
    const target = String(body.pid || '');
    if (!/^[0-9a-f]{32}$/.test(target) || target === pid) throw bad('Invalid player.');
    await q('DELETE FROM mining_friends WHERE (a = $1 AND b = $2) OR (a = $2 AND b = $1)', [pid, target]);
    return { ok: true };
  },

  async '/api/friend/list'({ pid }) {
    const rows = await q(
      `SELECT l.player_id AS pid, l.uid, l.name, l.avatar, l.xp, l.rank_idx, ${ONLINE_SQL} AS online, f.status, f.a AS fa
       FROM mining_friends f
       JOIN mining_leaderboard l ON l.player_id = CASE WHEN f.a = $1 THEN f.b ELSE f.a END
       WHERE f.a = $1 OR f.b = $1 ORDER BY l.name ASC LIMIT 250`, [pid]);
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const r of rows) {
      const x = { pid: r.pid, uid: Number(r.uid), name: r.name, avatar: r.avatar, xp: Number(r.xp), rank_idx: Number(r.rank_idx), online: isT(r.online) };
      if (r.status === 'accepted') out.friends.push(x);
      else if (r.fa === pid) out.outgoing.push(x);
      else out.incoming.push(x);
    }
    out.friends.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    return out;
  },

  // ----- admin / developer panel (kailangan ng X-Admin header = ADMIN_CODE) -----
  async '/api/admin/state'({ req }) {
    requireAdmin(req);
    const st = await getSettings(true);
    return { announcement: st.announcement, chat_on: st.chat_on, badwords: st.badwords };
  },

  async '/api/admin/announce'({ req, body }) {
    requireAdmin(req);
    const text = cleanText(body.text, 300);
    await setSetting('announcement', text ? JSON.stringify({ id: Date.now(), text }) : '');
    return { ok: true, cleared: !text };
  },

  async '/api/admin/chat'({ req, body }) {
    requireAdmin(req);
    const on = !!body.on;
    await setSetting('chat_on', on ? '1' : '0');
    return { ok: true, chat_on: on };
  },

  async '/api/admin/badwords'({ req, body }) {
    requireAdmin(req);
    const list = [...new Set(String(body.words || '').split(/[\n,]+/).map((w) => cleanText(w, 30)).filter(Boolean))].slice(0, 500);
    await setSetting('badwords', list.join('\n'));
    return { ok: true, badwords: list };
  },

  async '/api/admin/ban'({ req, body }) {
    requireAdmin(req);
    const p = await findPlayer(body.target);
    const on = !!body.on;
    await q('UPDATE mining_leaderboard SET banned = $2 WHERE player_id = $1', [p.pid, on]);
    banCache.delete(p.pid);
    return { ok: true, name: p.name, uid: Number(p.uid), on };
  },

  async '/api/admin/chatban'({ req, body }) {
    requireAdmin(req);
    const p = await findPlayer(body.target);
    const on = !!body.on;
    await q('UPDATE mining_leaderboard SET chat_banned = $2 WHERE player_id = $1', [p.pid, on]);
    return { ok: true, name: p.name, uid: Number(p.uid), on };
  },

  async '/api/admin/deleteteam'({ req, body }) {
    requireAdmin(req);
    const s = String(body.target || '').trim().replace(/^\$/, '').slice(0, 32);
    if (!s) throw bad('Enter a team name, tag or ID.');
    const r = await q('SELECT id, name, tag FROM mining_clans WHERE id::text = $1::text OR upper(tag) = upper($1::text) OR name_key = lower($1::text) LIMIT 3', [s]);
    if (!r.length) throw new HttpError(404, 'Team not found.');
    if (r.length > 1) throw bad('More than one team matches. Use the tag instead.');
    await purgeClan(String(r[0].id));
    await q('DELETE FROM mining_clans WHERE id = $1::bigint', [String(r[0].id)]);
    return { ok: true, name: r[0].name, tag: r[0].tag };
  },
};

async function purgeClan(id) {
  await q('DELETE FROM mining_reactions WHERE msg_id IN (SELECT id FROM mining_chat WHERE channel = $1)', ['clan:' + id]);
  await q('DELETE FROM mining_chat WHERE channel = $1', ['clan:' + id]);
  await q('DELETE FROM mining_clan_members WHERE clan_id = $1::bigint', [id]);
  await q('DELETE FROM mining_clan_requests WHERE clan_id = $1::bigint', [id]);
  await q('DELETE FROM mining_clan_invites WHERE clan_id = $1::bigint', [id]);
}
async function disband(pid, id) {
  await purgeClan(id);
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
    req.on('data', (c) => { size += c.length; if (size > 10000) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(bad('Invalid JSON.')); } });
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
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });

    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const h = ipHits.get(ip) || { n: 0 }; h.n++; ipHits.set(ip, h);
    if (h.n > 240) throw new HttpError(429, 'Too many requests.');

    const pid = pidFrom(req);
    const isAdmin = url.pathname.startsWith('/api/admin/');
    if (!pid && !isAdmin && url.pathname !== '/api/clan/list' && url.pathname !== '/api/avatars') throw new HttpError(401, 'Missing player ID.');
    const body = await readBody(req);
    await ensure();
    if (pid && !isAdmin) {
      if (await isBanned(pid)) { const be = new HttpError(403, 'You have been banned from this game.'); be.banned = true; throw be; }
      touch(pid);
    }
    send(res, 200, await handler({ pid, body, req }));
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, e.banned ? { error: e.message, banned: true } : { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});
server.listen(PORT, () => console.log('Mining Game server on :' + PORT));
