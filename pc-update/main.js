'use strict';
// Pocket Player for Windows: the desktop window, folder scanning, tags and album art, lyrics,
// tray, mini player, taskbar buttons, global hotkeys, playlists files, Discord status and power actions.
const {
  app, BrowserWindow, protocol, ipcMain, dialog, session, shell, Menu, Tray, nativeImage,
  globalShortcut, Notification, screen, clipboard, net: webNet
} = require('electron');
const dl = require('./downloads.js');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const net = require('node:net');
const LRCLIB = 'https://lrclib.net/api';
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { fileURLToPath } = require('node:url');

const APP_ID = 'com.pocketplayer.desktop';
const WWW = path.join(__dirname, 'www');
const ICON = path.join(__dirname, 'build', 'icon.png');
const AUDIO = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'weba', 'aif', 'aiff', 'wma'];
const VIDEO = ['mp4', 'm4v', 'mov', 'webm', 'mkv', '3gp', 'ogv', 'avi', 'wmv'];
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', weba: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff', wma: 'audio/x-ms-wma',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/webm', '3gp': 'video/3gpp',
  ogv: 'video/ogg', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv'
};
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', 'appdata', 'windows', 'program files', 'program files (x86)']);
const HOTKEYS = {
  'CommandOrControl+Alt+Space': 'toggle',
  'CommandOrControl+Alt+Right': 'next',
  'CommandOrControl+Alt+Left': 'prev',
  'CommandOrControl+Alt+Up': 'volUp',
  'CommandOrControl+Alt+Down': 'volDown',
  'CommandOrControl+Alt+L': 'fav',
  'CommandOrControl+Alt+M': 'mini'
};

// Linking devices: share this PC's real Wi-Fi address with the other device instead of a hidden
// ".local" name, which phones often can't look up, so devices on the same Wi-Fi can reach each other.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

protocol.registerSchemesAsPrivileged([{
  scheme: 'pocket',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);

if (!app.requestSingleInstanceLock()) app.quit();
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

let win = null, mini = null, tray = null;
let quitting = false;
let settings = {};
let tagCache = {};
let artDir = '';
const allowed = new Set();
let pendingOpen = [];
let lastState = { has: false };

const ext = (f) => path.extname(String(f)).slice(1).toLowerCase();
const kindOf = (f) => AUDIO.includes(ext(f)) ? 'audio' : VIDEO.includes(ext(f)) ? 'video' : null;
const keyOf = (f) => { const r = path.resolve(f); return process.platform === 'win32' ? r.toLowerCase() : r; };
const mediaUrl = (f) => 'pocket://app/media?p=' + encodeURIComponent(f);
const artUrl = (name) => 'pocket://app/art/' + encodeURIComponent(name);
const dataFile = (n) => path.join(app.getPath('userData'), n);
const alive = (w) => w && !w.isDestroyed();
const short = (s, n = 60) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function readJSON(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(f, v) {
  try { fs.writeFileSync(f, JSON.stringify(v)); } catch (e) { /* ignore */ }
}
const saveSettings = () => writeJSON(dataFile('settings.json'), settings);
let tagSaveTimer = null;
function saveTagsSoon() {
  clearTimeout(tagSaveTimer);
  tagSaveTimer = setTimeout(() => writeJSON(dataFile('tags.json'), tagCache), 1500);
}

/* ---------- serving the page, media files and album art ---------- */
async function serve(file, req) {
  let st;
  try { st = await fsp.stat(file); } catch (e) { return new Response('Not found', { status: 404 }); }
  if (!st.isFile()) return new Response('Not found', { status: 404 });
  const type = MIME[ext(file)] || 'application/octet-stream';
  const range = req.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = 0, end = st.size - 1;
    if (m) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, st.size - Number(m[2])); }
      else { start = Number(m[1] || 0); if (m[2] !== '') end = Math.min(Number(m[2]), st.size - 1); }
    }
    if (start >= st.size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
    }
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, {
      status: 206,
      headers: {
        'Content-Type': type, 'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes'
      }
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' }
  });
}

/* The app's own page files live inside the packed app (app.asar). The simple, synchronous
   file functions always work there, so they are used for these small files. */
function serveAppFile(candidates) {
  for (const file of candidates) {
    try {
      if (!fs.statSync(file).isFile()) continue;
      const data = fs.readFileSync(file);
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': MIME[ext(file)] || 'application/octet-stream', 'Content-Length': String(data.length) }
      });
    } catch (e) { /* try the next one */ }
  }
  // Show what the app can see, so a missing file is easy to track down
  let seen = '';
  try { seen += 'App folder: ' + __dirname + '\n  ' + fs.readdirSync(__dirname).join('\n  ') + '\n'; } catch (e) { seen += 'App folder unreadable: ' + e.message + '\n'; }
  try { seen += 'www folder:\n  ' + fs.readdirSync(WWW).join('\n  ') + '\n'; } catch (e) { seen += 'www folder missing (' + e.code + ')\n'; }
  return new Response('Not found: ' + path.basename(candidates[0] || '') + '  (version ' + app.getVersion() + ')\n\n' + seen,
    { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/* Internet radio and podcast streams are passed through the app so http-only stations still play. */
async function proxyStream(target, req) {
  if (!/^https?:\/\//i.test(target)) return new Response('Bad link', { status: 400 });
  const headers = { 'User-Agent': dl.UA, 'Icy-MetaData': '0' };
  const range = req.headers.get('range');
  if (range) headers.Range = range;
  const ctrl = new AbortController();
  let r;
  try { r = await webNet.fetch(target, { headers, signal: ctrl.signal, redirect: 'follow' }); }
  catch (e) { return new Response('Could not connect', { status: 502 }); }
  const h = new Headers();
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = r.headers.get(k); if (v) h.set(k, v);
  }
  if (!r.body) return new Response(null, { status: r.status, headers: h });
  const reader = r.body.getReader();
  const body = new ReadableStream({
    async pull(c) {
      try { const { done, value } = await reader.read(); if (done) c.close(); else c.enqueue(value); }
      catch (e) { try { c.error(e); } catch (e2) { /* closed */ } }
    },
    cancel() {
      try { reader.cancel().catch(() => {}); } catch (e) { /* ignore */ }
      try { ctrl.abort(); } catch (e) { /* ignore */ }
    }
  });
  return new Response(body, { status: r.status, headers: h });
}

function registerProtocol() {
  protocol.handle('pocket', async (req) => {
    const u = new URL(req.url);
    const p = decodeURIComponent(u.pathname);
    if (p === '/media') {
      const f = u.searchParams.get('p') || '';
      if (!allowed.has(keyOf(f))) return new Response('Not allowed', { status: 403 });
      return serve(f, req);
    }
    if (p.startsWith('/art/')) return serve(path.join(artDir, path.basename(p.slice(5))), req);
    if (p === '/stream') return proxyStream(u.searchParams.get('u') || '', req);
    if (p === '/vendor/jsmediatags.min.js') {
      return serveAppFile([
        path.join(__dirname, 'node_modules', 'jsmediatags', 'dist', 'jsmediatags.min.js'),
        path.join(WWW, 'vendor', 'jsmediatags.min.js')
      ]);
    }
    const rel = p.replace(/^\/+/, '') || 'index.html';
    const full = path.normalize(path.join(WWW, rel));
    if (!full.startsWith(WWW)) return new Response('Not allowed', { status: 403 });
    // also look next to main.js, in case the page files were uploaded without their www folder
    return serveAppFile([full, path.join(__dirname, path.basename(rel))]);
  });
}

/* ---------- finding music and video ---------- */
async function walk(dir, out, depth) {
  if (depth > 12 || out.length >= 30000) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name.toLowerCase())) await walk(full, out, depth + 1);
    } else if (e.isFile()) {
      const kind = kindOf(e.name);
      if (kind) out.push({ full, name: e.name, kind });
    }
  }
}

function withOverride(k, t) {
  const o = settings.overrides && settings.overrides[k];
  if (!o) return t || null;
  return Object.assign({}, t || {}, {
    title: o.title || (t && t.title) || '', artist: o.artist !== undefined ? o.artist : (t && t.artist) || '',
    album: o.album !== undefined ? o.album : (t && t.album) || '', art: o.art || (t && t.art) || null
  });
}

function toItem(full, name, kind, st, cached) {
  const c = withOverride(keyOf(full), cached);
  return {
    path: full, name, kind, size: st.size, mtime: st.mtimeMs, url: mediaUrl(full),
    title: (c && c.title) || '', artist: (c && c.artist) || '', album: (c && c.album) || '',
    art: c && c.art ? artUrl(c.art) : null
  };
}

function freshTags(k, st) {
  const c = tagCache[k];
  return c && c.size === st.size && c.mtime === st.mtimeMs ? c : null;
}

/* ---------- song tags, album art and lyrics ---------- */
let jsmediatags = null;
try { jsmediatags = require('jsmediatags'); } catch (e) { jsmediatags = null; }
let NodeID3 = null;
try { NodeID3 = require('node-id3'); } catch (e) { NodeID3 = null; }

function rawTags(full) {
  return new Promise((resolve) => {
    if (!jsmediatags) return resolve(null);
    const timer = setTimeout(() => resolve(null), 10000);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    try {
      jsmediatags.read(full, { onSuccess: ({ tags }) => done(tags || {}), onError: () => done(null) });
    } catch (e) { done(null); }
  });
}

function saveArt(buf, mime) {
  try {
    const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + (/png/i.test(mime || '') ? '.png' : '.jpg');
    const f = path.join(artDir, name);
    if (!fs.existsSync(f)) fs.writeFileSync(f, buf);
    return name;
  } catch (e) { return null; }
}

async function readTags(full) {
  const tags = await rawTags(full);
  if (!tags) return {};
  let art = null;
  const pic = tags.picture;
  if (pic && pic.data && pic.data.length) art = saveArt(Buffer.from(pic.data), pic.format);
  return { title: tags.title || '', artist: tags.artist || '', album: tags.album || '', art };
}

let tagJob = 0;
async function readTagsLater(list, wc) {
  const job = ++tagJob;
  let batch = [];
  for (const it of list) {
    if (job !== tagJob || wc.isDestroyed()) return;
    const t = await readTags(it.full);
    const entry = { size: it.st.size, mtime: it.st.mtimeMs, title: t.title || '', artist: t.artist || '', album: t.album || '', art: t.art || null };
    tagCache[it.k] = entry;
    const shown = withOverride(it.k, entry);
    batch.push({ path: it.full, title: shown.title, artist: shown.artist, album: shown.album, art: shown.art ? artUrl(shown.art) : null });
    if (batch.length >= 25) {
      if (!wc.isDestroyed()) wc.send('tags', batch);
      batch = [];
      saveTagsSoon();
    }
  }
  if (batch.length && !wc.isDestroyed()) wc.send('tags', batch);
  saveTagsSoon();
}

/* lyrics the user saved where the song's folder isn't writable, or that were found online */
let lyricsDir = '';
const lyrKey = (full) => crypto.createHash('sha1').update(keyOf(full)).digest('hex').slice(0, 24);
const sideLrc = (full) => full.slice(0, full.length - path.extname(full).length) + '.lrc';

function cleanTitle(s) {
  return String(s || '')
    .replace(/\s*[([][^)\]]*(official|video|audio|lyric|visuali[sz]er|\bhd\b|\b4k\b|\bmv\b|remaster|explicit|clean version)[^)\]]*[)\]]/gi, '')
    .replace(/\s+(ft\.?|feat\.?|featuring)\s.+$/i, '')
    .replace(/\s{2,}/g, ' ').trim();
}
async function lrclib(url) {
  const r = await webNet.fetch(url, { headers: { 'User-Agent': 'PocketPlayer/1.0 (Windows music player)' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function searchLyricsOnline(q) {
  let title = cleanTitle(q.title), artist = String(q.artist || '').trim();
  if (!artist && / - /.test(title)) { const i = title.indexOf(' - '); artist = title.slice(0, i).trim(); title = title.slice(i + 3).trim(); }
  if (!title) return null;
  const dur = Number(q.duration) || 0;
  let hit = null;
  if (artist && q.album && dur > 0) {
    const u = new URL(LRCLIB + '/get');
    u.searchParams.set('track_name', title); u.searchParams.set('artist_name', artist);
    u.searchParams.set('album_name', q.album); u.searchParams.set('duration', String(Math.round(dur)));
    try { hit = await lrclib(u.toString()); } catch (e) { hit = null; }
  }
  if (!hit || (!hit.syncedLyrics && !hit.plainLyrics)) {
    const u = new URL(LRCLIB + '/search');
    if (artist) { u.searchParams.set('track_name', title); u.searchParams.set('artist_name', artist); }
    else u.searchParams.set('q', title);
    let list = await lrclib(u.toString());
    if ((!Array.isArray(list) || !list.length) && artist) {
      const u2 = new URL(LRCLIB + '/search'); u2.searchParams.set('q', artist + ' ' + title);
      list = await lrclib(u2.toString());
    }
    if (Array.isArray(list) && list.length) {
      const score = (x) => (x.syncedLyrics ? 2 : x.plainLyrics ? 1 : -9) + (dur && x.duration && Math.abs(x.duration - dur) <= 3 ? 3 : 0);
      hit = list.filter((x) => !x.instrumental).sort((a, b) => score(b) - score(a))[0] || null;
    }
  }
  return hit && (hit.syncedLyrics || hit.plainLyrics) || null;
}

async function findLyrics(full) {
  try {
    const saved = (await fsp.readFile(path.join(lyricsDir, lyrKey(full) + '.lrc'), 'utf8')).replace(/^﻿/, '');
    if (saved.trim()) return { text: saved, source: 'saved' };
  } catch (e) { /* none saved */ }
  const base = full.slice(0, full.length - path.extname(full).length);
  const tries = [base + '.lrc', path.join(path.dirname(full), 'Lyrics', path.basename(base) + '.lrc')];
  for (const f of tries) {
    try {
      const txt = (await fsp.readFile(f, 'utf8')).replace(/^﻿/, '');
      if (txt.trim()) return { text: txt, source: 'file' };
    } catch (e) { /* not there */ }
  }
  const tags = await rawTags(full);
  if (tags && tags.lyrics) {
    const l = typeof tags.lyrics === 'string' ? tags.lyrics : (tags.lyrics.lyrics || '');
    if (l && l.trim()) return { text: l, source: 'tag' };
  }
  return null;
}

/* ---------- files opened with "Open with Pocket Player" or from playlists ---------- */
function mediaArgs(argv) {
  return argv.slice(1).filter((a) => a && !a.startsWith('-') && kindOf(a) && fs.existsSync(a));
}
function itemsFor(paths, wc) {
  const items = [], need = [], seen = new Set();
  for (const full of paths) {
    try {
      const k = keyOf(full);
      if (seen.has(k)) continue;
      seen.add(k);
      const st = fs.statSync(full);
      allowed.add(k);
      const cached = freshTags(k, st);
      items.push(toItem(full, path.basename(full), kindOf(full), st, cached));
      if (kindOf(full) === 'audio' && !cached) need.push({ full, k, st });
    } catch (e) { /* skip */ }
  }
  if (need.length && wc) readTagsLater(need, wc);
  return items;
}

/* ---------- watching folders for new files ---------- */
let watchers = [], watchTimer = null;
function watchFolders() {
  for (const w of watchers) { try { w.close(); } catch (e) { /* ignore */ } }
  watchers = [];
  for (const folder of settings.folders) {
    try {
      const w = fs.watch(folder, { recursive: true }, (_ev, name) => {
        const n = String(name || '');
        if (path.extname(n) && !kindOf(n)) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => { if (alive(win)) win.webContents.send('library-changed'); }, 2500);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch (e) { /* folder missing */ }
  }
}

/* ---------- commands to the player ---------- */
function sendCmd(cmd, value) {
  if (cmd === 'mini') { toggleMini(); return; }
  if (alive(win)) win.webContents.send('command', { cmd, value });
}

function showMain() {
  if (!alive(win)) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------- mini player ---------- */
function onScreen(p) {
  if (!p || typeof p.x !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return p.x >= a.x - 40 && p.y >= a.y - 40 && p.x < a.x + a.width - 60 && p.y < a.y + a.height - 40;
  });
}
function openMini() {
  if (!alive(mini)) {
    const p = onScreen(settings.miniPos) ? settings.miniPos : {};
    mini = new BrowserWindow({
      width: 400, height: 132, x: p.x, y: p.y,
      frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false,
      backgroundColor: '#121218', title: 'Pocket Player', icon: ICON,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false }
    });
    mini.setAlwaysOnTop(true, 'floating');
    mini.loadURL('pocket://app/mini.html');
    mini.once('ready-to-show', () => { if (alive(mini)) mini.show(); });
    mini.on('moved', () => {
      if (!alive(mini)) return;
      const b = mini.getBounds();
      settings.miniPos = { x: b.x, y: b.y };
      saveSettings();
    });
    mini.on('closed', () => { mini = null; });
  } else {
    mini.show();
  }
  if (alive(win)) win.hide();
}
function closeMini(showFull) {
  if (alive(mini)) mini.close();
  if (showFull || !settings.tray || !tray) showMain();
}
function toggleMini() {
  if (alive(mini) && mini.isVisible()) closeMini(true);
  else openMini();
}

/* ---------- tray ---------- */
function makeTray() {
  try {
    const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('Pocket Player');
    tray.on('click', showMain);
    updateTray();
  } catch (e) { tray = null; }
}
function updateTray() {
  if (!tray) return;
  const s = lastState || {};
  tray.setToolTip(s.has ? short(`${s.title}${s.artist ? ' – ' + s.artist : ''}`, 120) : 'Pocket Player');
  const items = [
    { label: s.has ? short(s.title) : 'Nothing playing', enabled: false }
  ];
  if (s.has && s.artist) items.push({ label: short(s.artist), enabled: false });
  items.push(
    { type: 'separator' },
    { label: s.playing ? 'Pause' : 'Play', click: () => sendCmd('toggle') },
    { label: 'Next', click: () => sendCmd('next'), enabled: !!s.has },
    { label: 'Previous', click: () => sendCmd('prev'), enabled: !!s.has },
    { label: s.fav ? 'Remove from favourites' : 'Add to favourites', click: () => sendCmd('fav'), enabled: !!s.has },
    { type: 'separator' },
    { label: 'Mini player', click: () => openMini() },
    { label: 'Open Pocket Player', click: showMain },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  );
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/* ---------- taskbar buttons and progress ---------- */
const thumbIcon = (n) => nativeImage.createFromPath(path.join(__dirname, 'build', 'thumb', n + '.png'));
function updateThumbar() {
  if (process.platform !== 'win32' || !alive(win)) return;
  const s = lastState || {};
  const off = s.has ? [] : ['disabled'];
  try {
    win.setThumbarButtons([
      { tooltip: 'Previous', icon: thumbIcon('prev'), click: () => sendCmd('prev'), flags: off },
      { tooltip: s.playing ? 'Pause' : 'Play', icon: thumbIcon(s.playing ? 'pause' : 'play'), click: () => sendCmd('toggle') },
      { tooltip: 'Next', icon: thumbIcon('next'), click: () => sendCmd('next'), flags: off }
    ]);
  } catch (e) { /* not supported */ }
}
function updateProgress() {
  if (!alive(win)) return;
  const s = lastState || {};
  try {
    if (s.has && s.dur > 0) win.setProgressBar(Math.min(1, Math.max(0, s.pos / s.dur)), { mode: s.playing ? 'normal' : 'paused' });
    else win.setProgressBar(-1);
  } catch (e) { /* ignore */ }
}

/* ---------- song-change notifications ---------- */
function artImage(art) {
  if (art && art.startsWith('pocket://app/art/')) {
    const img = nativeImage.createFromPath(path.join(artDir, path.basename(decodeURIComponent(art.slice(17)))));
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createFromPath(ICON);
}
function notify(title, body, icon) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: short(title, 100), body: short(body, 200), silent: true, icon: icon || nativeImage.createFromPath(ICON) });
    n.on('click', showMain);
    n.show();
  } catch (e) { /* ignore */ }
}
let notifiedId = '';
function maybeNotify(s) {
  if (!settings.notify || !s.has || !s.playing || s.id === notifiedId) return;
  notifiedId = s.id;
  const looking = (alive(win) && win.isVisible() && win.isFocused()) || (alive(mini) && mini.isVisible());
  if (looking) return;
  notify(s.title, s.artist || (s.kind === 'video' ? 'Video' : 'Pocket Player'), artImage(s.art));
}

/* ---------- Discord "Listening to" status ---------- */
const discord = {
  sock: null, ready: false, clientId: '', retry: null, buf: Buffer.alloc(0), pending: undefined, status: 'Off',
  setStatus(s) { this.status = s; if (alive(win)) win.webContents.send('discord', s); },
  start(id) {
    this.stop();
    this.clientId = id || '';
    if (!this.clientId) { this.setStatus('Off'); return; }
    this.setStatus('Connecting…');
    this.connect(0);
  },
  stop() {
    clearTimeout(this.retry); this.retry = null;
    const s = this.sock; this.sock = null; this.ready = false; this.buf = Buffer.alloc(0);
    if (s) { try { s.destroy(); } catch (e) { /* ignore */ } }
  },
  later(ms) {
    clearTimeout(this.retry);
    if (!this.clientId) return;
    this.retry = setTimeout(() => this.connect(0), ms || 20000);
  },
  connect(i) {
    if (!this.clientId || this.sock) return;
    const pipe = process.platform === 'win32'
      ? `\\\\?\\pipe\\discord-ipc-${i}`
      : path.join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || '/tmp', `discord-ipc-${i}`);
    const s = net.createConnection(pipe);
    let opened = false;
    s.once('connect', () => {
      opened = true; this.sock = s;
      this.send(0, { v: 1, client_id: this.clientId });
    });
    s.on('data', (d) => this.onData(d));
    s.on('error', () => {
      if (!opened) {
        s.destroy();
        if (i < 9) this.connect(i + 1);
        else { this.setStatus('Waiting for Discord to open'); this.later(); }
      }
    });
    s.on('close', () => {
      if (this.sock === s) {
        this.sock = null; this.ready = false;
        if (this.status === 'Connected') this.setStatus('Waiting for Discord to open');
        this.later();
      }
    });
  },
  send(op, obj) {
    if (!this.sock) return;
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32LE(op, 0); head.writeUInt32LE(json.length, 4);
    try { this.sock.write(Buffer.concat([head, json])); } catch (e) { /* ignore */ }
  },
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0), len = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let msg = {};
      try { msg = JSON.parse(this.buf.slice(8, 8 + len).toString('utf8')); } catch (e) { msg = {}; }
      this.buf = this.buf.slice(8 + len);
      if (op === 1 && msg.evt === 'READY') {
        this.ready = true; this.setStatus('Connected');
        if (this.pending !== undefined) this.activity(this.pending);
      } else if (op === 2) {
        this.setStatus(msg.message ? 'Discord says: ' + msg.message : 'Discord closed the connection');
        const s = this.sock; this.sock = null; this.ready = false;
        if (s) s.destroy();
        this.later(120000);
      } else if (op === 3) {
        this.send(4, msg);
      }
    }
  },
  activity(act) {
    this.pending = act;
    if (!this.ready) return;
    this.send(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: act || undefined }, nonce: crypto.randomUUID() });
  }
};
function updateDiscord(s) {
  if (!discord.clientId) return;
  if (!s || !s.has) { discord.activity(null); return; }
  const pad = (t) => { t = String(t || '').slice(0, 128); return t.length < 2 ? (t + '  ').slice(0, 2) : t; };
  const act = { type: 2, details: pad(s.title), state: pad(s.playing ? (s.artist ? 'by ' + s.artist : 'Pocket Player') : 'Paused'), instance: false };
  if (s.playing && s.dur > 0) {
    const start = Date.now() - Math.round(s.pos * 1000);
    act.timestamps = { start, end: start + Math.round(s.dur * 1000) };
  }
  discord.activity(act);
}

/* ---------- global hotkeys ---------- */
function applyHotkeys() {
  globalShortcut.unregisterAll();
  if (!settings.keys) return true;
  let ok = true;
  for (const [accel, cmd] of Object.entries(HOTKEYS)) {
    try { if (!globalShortcut.register(accel, () => sendCmd(cmd))) ok = false; } catch (e) { ok = false; }
  }
  return ok;
}

/* ---------- start with Windows ---------- */
function applyLogin() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.login,
      path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      args: ['--hidden']
    });
  } catch (e) { /* ignore */ }
}

/* ---------- power actions for the sleep timer ---------- */
function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true }, (err) => err ? reject(err) : resolve(true)));
}

/* ---------- downloads ---------- */
let dlDir = '', manager = null;
const recvFiles = new Map();
let recvSeq = 0;
function ensureDownloadsWatched() {
  const k = keyOf(dlDir);
  const covered = settings.folders.some((f) => { const fk = keyOf(f); return k === fk || k.startsWith(fk + path.sep); });
  if (!covered) { settings.folders.push(dlDir); saveSettings(); watchFolders(); }
}
function setupDownloads() {
  try { dlDir = path.join(app.getPath('music'), 'Pocket Player Downloads'); }
  catch (e) { dlDir = path.join(app.getPath('downloads'), 'Pocket Player'); }
  manager = new dl.DownloadManager({
    fetch: (u, o) => webNet.fetch(u, o),
    dirFor: (media, sub) => {
      if (!media) return app.getPath('downloads');
      const parts = String(sub || '').split(/[\\/]+/).filter(Boolean).map(dl.safeName);
      return path.join(dlDir, ...parts);
    },
    onUpdate: (it) => { if (alive(win)) win.webContents.send('dl-update', it); },
    onDone: (it) => {
      if (it.media) { allowed.add(keyOf(it.file)); fs.mkdirSync(dlDir, { recursive: true }); ensureDownloadsWatched(); }
      if (alive(win)) win.webContents.send('dl-done', it);
      if (!(alive(win) && win.isVisible() && win.isFocused())) notify('Download finished', it.name);
    }
  });
}

async function webGet(url, as) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error('Bad link');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await webNet.fetch(url, { headers: { 'User-Agent': dl.UA, Accept: as === 'json' ? 'application/json' : '*/*' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8e6) throw new Error('Too large');
    const text = buf.toString('utf8');
    return as === 'json' ? JSON.parse(text) : text;
  } finally { clearTimeout(timer); }
}

/* ---------- messages from the page ---------- */
function registerIpc() {
  ipcMain.handle('dl-inspect', (_e, url) => dl.inspect((u, o) => webNet.fetch(u, o), url));
  ipcMain.handle('dl-add', (_e, d) => {
    try { return manager.add({ url: d && d.url, name: d && d.name, subdir: d && d.subdir }); }
    catch (e) { return { error: e.message }; }
  });
  ipcMain.handle('dl-list', () => manager.list());
  ipcMain.handle('dl-cancel', (_e, id) => manager.cancel(id));
  ipcMain.handle('dl-retry', (_e, id) => manager.retry(id));
  ipcMain.handle('dl-clear', () => { manager.clearFinished(); return manager.list(); });
  ipcMain.handle('dl-show', (_e, id) => {
    const it = manager.items.get(id);
    if (it && it.file && fs.existsSync(it.file)) shell.showItemInFolder(it.file);
  });
  ipcMain.handle('dl-folder', async () => { await fsp.mkdir(dlDir, { recursive: true }); shell.openPath(dlDir); return dlDir; });
  ipcMain.handle('dl-dir', () => dlDir);

  /* files sent from another device (phone or PC) */
  ipcMain.handle('recv-open', async (_e, name) => {
    const dir = path.join(dlDir, 'Received');
    await fsp.mkdir(dir, { recursive: true });
    const safe = dl.safeName(name || 'song');
    const ext = path.extname(safe), base = safe.slice(0, safe.length - ext.length);
    let file = path.join(dir, safe);
    for (let i = 2; fs.existsSync(file) || fs.existsSync(file + '.part'); i++) file = path.join(dir, `${base} (${i})${ext}`);
    const id = 'r' + (++recvSeq);
    recvFiles.set(id, { file, fd: await fsp.open(file + '.part', 'w') });
    return id;
  });
  ipcMain.handle('recv-write', async (_e, id, chunk) => {
    const r = recvFiles.get(id); if (!r) throw new Error('closed');
    const buf = Buffer.from(chunk.buffer ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : chunk);
    await r.fd.write(buf);
    return true;
  });
  ipcMain.handle('recv-close', async (_e, id) => {
    const r = recvFiles.get(id); if (!r) throw new Error('closed');
    recvFiles.delete(id);
    await r.fd.close();
    await fsp.rename(r.file + '.part', r.file);
    allowed.add(keyOf(r.file)); ensureDownloadsWatched();
    return { path: r.file, name: path.basename(r.file) };
  });
  ipcMain.handle('recv-abort', async (_e, id) => {
    const r = recvFiles.get(id); if (!r) return;
    recvFiles.delete(id);
    try { await r.fd.close(); } catch (e) { /* ignore */ }
    try { await fsp.unlink(r.file + '.part'); } catch (e) { /* ignore */ }
  });
  ipcMain.handle('clipboard-text', () => clipboard.readText().slice(0, 4000));
  ipcMain.handle('web-get', async (_e, d) => {
    try { return { ok: true, data: await webGet(d && d.url, d && d.as) }; }
    catch (e) { return { ok: false, error: e.message || 'Request failed' }; }
  });

  ipcMain.handle('folders', () => settings.folders);

  ipcMain.handle('scan', async (event) => {
    const files = [];
    for (const folder of settings.folders) await walk(folder, files, 0);
    const seen = new Set(), items = [], need = [];
    for (const f of files) {
      const k = keyOf(f.full);
      if (seen.has(k)) continue;
      seen.add(k);
      let st;
      try { st = await fsp.stat(f.full); } catch (e) { continue; }
      allowed.add(k);
      const cached = freshTags(k, st);
      items.push(toItem(f.full, f.name, f.kind, st, cached));
      if (f.kind === 'audio' && !cached) need.push({ full: f.full, k, st });
    }
    if (need.length) readTagsLater(need, event.sender);
    return { items, folders: settings.folders };
  });

  ipcMain.handle('add-folder', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a folder with music or videos', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return { added: false, folders: settings.folders };
    const have = new Set(settings.folders.map(keyOf));
    for (const f of r.filePaths) if (!have.has(keyOf(f))) settings.folders.push(f);
    saveSettings(); watchFolders();
    return { added: true, folders: settings.folders };
  });

  ipcMain.handle('remove-folder', (_e, folder) => {
    settings.folders = settings.folders.filter((f) => keyOf(f) !== keyOf(folder));
    saveSettings(); watchFolders();
    return settings.folders;
  });

  ipcMain.handle('take-open-files', (event) => {
    const items = itemsFor(pendingOpen, event.sender);
    pendingOpen = [];
    return items;
  });

  ipcMain.handle('resolve-paths', (event, paths) => {
    const ok = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && kindOf(p) && fs.existsSync(p));
    return itemsFor(ok, event.sender);
  });

  ipcMain.handle('lyrics', async (_e, full) => {
    if (typeof full !== 'string' || !allowed.has(keyOf(full))) return null;
    return findLyrics(full);
  });

  ipcMain.handle('save-lyrics', async (_e, d) => {
    const full = d && d.path;
    if (typeof full !== 'string' || !allowed.has(keyOf(full))) return { ok: false, error: 'That file isn’t in your library.' };
    const text = String(d.text || '').slice(0, 500000);
    const appFile = path.join(lyricsDir, lyrKey(full) + '.lrc'), side = sideLrc(full);
    if (!text.trim()) {
      for (const f of [appFile, side]) { try { await fsp.unlink(f); } catch (e) { /* not there */ } }
      try { await fsp.writeFile(path.join(lyricsDir, lyrKey(full) + '.none'), ''); } catch (e) { /* ignore */ }
      return { ok: true, where: 'removed' };
    }
    const body = text.replace(/\r?\n/g, '\r\n');
    try {
      await fsp.writeFile(side, body, 'utf8');
      try { await fsp.unlink(appFile); } catch (e) { /* none */ }
      return { ok: true, where: 'file' };
    } catch (e) {
      try { await fsp.writeFile(appFile, body, 'utf8'); return { ok: true, where: 'app' }; }
      catch (e2) { return { ok: false, error: 'Couldn’t save the lyrics.' }; }
    }
  });

  ipcMain.handle('find-lyrics', async (_e, q) => {
    const full = q && q.path;
    if (typeof full !== 'string' || !allowed.has(keyOf(full))) return null;
    const none = path.join(lyricsDir, lyrKey(full) + '.none');
    if (q.auto) {
      try { const st = await fsp.stat(none); if (Date.now() - st.mtimeMs < 14 * 864e5) return null; } catch (e) { /* not tried yet */ }
    }
    let text = null;
    try { text = await searchLyricsOnline(q); }
    catch (e) { return q.auto ? null : { error: 'Couldn’t reach the lyrics service. Check your internet connection.' }; }
    if (!text) {
      if (q.auto) { try { await fsp.writeFile(none, ''); } catch (e) { /* ignore */ } }
      return null;
    }
    if (q.auto) { try { await fsp.writeFile(path.join(lyricsDir, lyrKey(full) + '.lrc'), text, 'utf8'); } catch (e) { /* ignore */ } }
    return { text, source: 'LRCLIB' };
  });

  ipcMain.handle('show-in-folder', (_e, full) => {
    if (typeof full === 'string' && allowed.has(keyOf(full))) shell.showItemInFolder(full);
  });

  ipcMain.handle('edit-tags', async (_e, d) => {
    const full = d && d.path;
    if (typeof full !== 'string' || !allowed.has(keyOf(full))) return { ok: false, error: 'That file isn’t in your library.' };
    const k = keyOf(full);
    const clean = (v) => String(v || '').slice(0, 300);
    const title = clean(d.title), artist = clean(d.artist), album = clean(d.album);
    let artName = null, imgBuf = null;
    const mime = d.image && /png/i.test(d.image.mime || '') ? 'image/png' : 'image/jpeg';
    if (d.image && d.image.bytes && d.image.bytes.length) {
      imgBuf = Buffer.from(d.image.bytes);
      artName = saveArt(imgBuf, mime);
    }
    if (/\.mp3$/i.test(full) && NodeID3) {
      const tags = { title, artist, album };
      if (imgBuf) tags.image = { mime, type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer: imgBuf };
      let r;
      try { r = NodeID3.update(tags, full); } catch (err) { r = err; }
      if (r !== true) return { ok: false, error: 'Windows didn’t let Pocket Player change that file. It might be read-only or open in another app.' };
      if (settings.overrides) delete settings.overrides[k];
      saveSettings();
      const st = await fsp.stat(full);
      const t = await readTags(full);
      const old = tagCache[k] || {};
      tagCache[k] = { size: st.size, mtime: st.mtimeMs, title: t.title || title, artist: t.artist || artist, album: t.album || album, art: t.art || artName || old.art || null };
      saveTagsSoon();
      return { ok: true, where: 'file', art: tagCache[k].art ? artUrl(tagCache[k].art) : null };
    }
    settings.overrides = settings.overrides || {};
    const prev = settings.overrides[k] || {};
    settings.overrides[k] = { title, artist, album, art: artName || prev.art || null };
    saveSettings();
    const shown = withOverride(k, tagCache[k]);
    return { ok: true, where: 'app', art: shown && shown.art ? artUrl(shown.art) : null };
  });

  ipcMain.handle('import-m3u', async (event) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import a playlist', properties: ['openFile'],
      filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = r.filePaths[0];
    const txt = (await fsp.readFile(file, 'utf8')).replace(/^﻿/, '');
    const dir = path.dirname(file), paths = [];
    let missing = 0;
    for (let line of txt.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      let p = line;
      if (/^file:/i.test(p)) { try { p = fileURLToPath(p); } catch (e) { missing++; continue; } }
      else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) { missing++; continue; }
      if (!path.isAbsolute(p)) p = path.resolve(dir, p);
      if (kindOf(p) && fs.existsSync(p)) paths.push(p); else missing++;
    }
    return { name: path.basename(file).replace(/\.m3u8?$/i, '') || 'Imported playlist', items: itemsFor(paths, event.sender), missing };
  });

  ipcMain.handle('export-m3u', async (_e, d) => {
    if (!d || !Array.isArray(d.entries)) return { saved: false };
    const safe = String(d.name || 'Playlist').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'Playlist';
    let def;
    try { def = path.join(app.getPath('music'), safe + '.m3u8'); } catch (e) { def = safe + '.m3u8'; }
    const r = await dialog.showSaveDialog(win, { title: 'Export playlist', defaultPath: def, filters: [{ name: 'Playlist', extensions: ['m3u8'] }] });
    if (r.canceled || !r.filePath) return { saved: false };
    const lines = ['#EXTM3U'];
    for (const en of d.entries) {
      if (!en || typeof en.path !== 'string') continue;
      lines.push(`#EXTINF:${Number(en.dur) > 0 ? Math.round(en.dur) : -1},${en.artist ? en.artist + ' - ' : ''}${en.title || path.basename(en.path)}`);
      lines.push(en.path);
    }
    await fsp.writeFile(r.filePath, lines.join('\r\n') + '\r\n', 'utf8');
    return { saved: true };
  });

  ipcMain.handle('power', async (_e, action) => {
    if (process.platform !== 'win32') throw new Error('Only available on Windows');
    if (action === 'sleep') {
      return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)']);
    }
    if (action === 'shutdown') return run('shutdown.exe', ['/s', '/t', '60', '/c', 'Pocket Player: the sleep timer finished.']);
    if (action === 'cancel') return run('shutdown.exe', ['/a']);
    throw new Error('Unknown action');
  });

  ipcMain.on('state', (e, s) => {
    if (!alive(win) || e.sender !== win.webContents || !s) return;
    const prevKey = [lastState.id, lastState.playing, lastState.title, lastState.artist, lastState.fav].join('|');
    lastState = s;
    if (alive(mini)) mini.webContents.send('state', s);
    updateProgress();
    const key = [s.id, s.playing, s.title, s.artist, s.fav].join('|');
    if (key !== prevKey) { updateThumbar(); updateTray(); updateDiscord(s); }
    maybeNotify(s);
  });
  ipcMain.handle('get-state', () => lastState);
  ipcMain.on('command', (_e, d) => { if (d && typeof d.cmd === 'string') sendCmd(d.cmd, d.value); });
  ipcMain.on('toggle-mini', () => toggleMini());
  ipcMain.on('mini-expand', () => closeMini(true));
  ipcMain.on('mini-close', () => closeMini(false));

  ipcMain.handle('get-pc-settings', () => ({
    tray: settings.tray, login: settings.login, notify: settings.notify, keys: settings.keys,
    discordId: settings.discordId, discordStatus: discord.status
  }));
  ipcMain.handle('set-pc-settings', (_e, p) => {
    const out = {};
    p = p || {};
    if ('tray' in p) settings.tray = !!p.tray;
    if ('notify' in p) settings.notify = !!p.notify;
    if ('login' in p) { settings.login = !!p.login; applyLogin(); }
    if ('keys' in p) { settings.keys = !!p.keys; out.keysFailed = !applyHotkeys(); }
    if ('discordId' in p) {
      settings.discordId = String(p.discordId || '').trim();
      discord.start(settings.discordId);
      if (lastState.has) setTimeout(() => updateDiscord(lastState), 1500);
    }
    saveSettings();
    return out;
  });
}

/* ---------- main window ---------- */
function createWindow(startHidden) {
  const b = settings.bounds || {};
  const pos = onScreen(b) ? b : {};
  win = new BrowserWindow({
    width: b.width || 1220, height: b.height || 840, x: pos.x, y: pos.y,
    minWidth: 380, minHeight: 560,
    backgroundColor: '#101014', title: 'Pocket Player', icon: ICON,
    autoHideMenuBar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true,
      backgroundThrottling: false
    }
  });
  if (settings.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!startHidden) win.show(); updateThumbar(); });
  win.on('show', updateThumbar);

  const saveBounds = () => {
    if (!alive(win)) return;
    settings.maximized = win.isMaximized();
    if (!settings.maximized && !win.isMinimized() && win.isVisible()) settings.bounds = win.getBounds();
    saveSettings();
  };
  win.on('close', (e) => {
    saveBounds();
    if (!quitting && settings.tray && tray) {
      e.preventDefault();
      win.hide();
      if (!settings.trayHintShown) {
        settings.trayHintShown = true; saveSettings();
        notify('Pocket Player is still running', 'It’s in the system tray by the clock. Right-click the icon to quit, or turn this off in the PC panel.');
      }
    }
  });
  win.on('closed', () => { win = null; if (alive(mini)) mini.close(); });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('pocket://')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools();
    }
  });
  win.webContents.on('did-finish-load', () => { win.webContents.send('discord', discord.status); });

  win.loadURL('pocket://app/index.html');
}

app.on('second-instance', (_e, argv) => {
  if (!alive(win)) return;
  if (alive(mini) && mini.isVisible()) mini.focus(); else showMain();
  const items = itemsFor(mediaArgs(argv), win.webContents);
  if (items.length) win.webContents.send('open-files', items);
});

app.whenReady().then(() => {
  artDir = dataFile('art');
  fs.mkdirSync(artDir, { recursive: true });
  lyricsDir = dataFile('lyrics');
  fs.mkdirSync(lyricsDir, { recursive: true });
  settings = Object.assign(
    { folders: null, tray: true, login: false, notify: true, keys: true, discordId: '', overrides: {} },
    readJSON(dataFile('settings.json'), {})
  );
  if (!Array.isArray(settings.folders)) {
    settings.folders = ['music', 'videos'].map((n) => { try { return app.getPath(n); } catch (e) { return null; } })
      .filter((f) => f && fs.existsSync(f));
    saveSettings();
  }
  tagCache = readJSON(dataFile('tags.json'), {});
  pendingOpen = mediaArgs(process.argv);

  const ok = new Set(['media', 'fullscreen', 'speaker-selection', 'mediaKeySystem', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(ok.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ok.has(perm));

  Menu.setApplicationMenu(null);
  setupDownloads();
  registerProtocol();
  registerIpc();
  makeTray();
  const startHidden = process.argv.includes('--hidden') && settings.tray && !!tray && !pendingOpen.length;
  createWindow(startHidden);
  applyHotkeys();
  watchFolders();
  if (settings.discordId) discord.start(settings.discordId);
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  writeJSON(dataFile('tags.json'), tagCache);
  discord.stop();
});
app.on('window-all-closed', () => { app.quit(); });
