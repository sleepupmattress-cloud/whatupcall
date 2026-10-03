// SleepUp WhatsApp web dialer — signaling server
// Browser (WebRTC) <-> this server <-> WhatsApp Cloud API Calling (Graph API + "calls" webhook)
import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

for (const k of ['WA_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'AGENTS']) {
  if (!env[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

const cfg = {
  port: Number(env.PORT || 3100),
  token: env.WA_TOKEN,
  phoneNumberId: env.PHONE_NUMBER_ID,
  appSecret: env.APP_SECRET || '',
  verifyToken: env.VERIFY_TOKEN,
  graphVersion: env.GRAPH_VERSION || 'v23.0',
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  countryCode: env.DEFAULT_COUNTRY_CODE || '91',
  permissionText: env.PERMISSION_TEXT ||
    'Vanakkam! SleepUp Mattress team ungalukku WhatsApp la call panni details solla virumbudhu. Call panna "Allow" click pannunga.',
  permissionTemplate: env.PERMISSION_TEMPLATE_NAME || '',
  permissionTemplateLang: env.PERMISSION_TEMPLATE_LANG || 'en',
  makeWebhook: env.MAKE_WEBHOOK_URL || '',
  ringSeconds: Number(env.INCOMING_RING_SECONDS || 25),
};
if (!cfg.appSecret) console.warn('APP_SECRET not set: webhook signatures are NOT verified.');
if (!env.SESSION_SECRET) console.warn('SESSION_SECRET not set: telecallers get logged out on every restart.');

// AGENTS="name:pin,name2:pin2"
const agents = new Map(
  env.AGENTS.split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const i = pair.lastIndexOf(':');
    return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
  })
);
const findAgent = name => [...agents.keys()].find(a => a.toLowerCase() === String(name || '').trim().toLowerCase());

// ---------- helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const iso = ms => (ms ? new Date(ms).toISOString() : null);

function makeToken(name) {
  const payload = Buffer.from(JSON.stringify({ n: name, t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', `${cfg.sessionSecret}|${agents.get(name)}`).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  try {
    const { n } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!agents.has(n)) return null; // removed agent or changed PIN => token dies
    const expected = crypto.createHmac('sha256', `${cfg.sessionSecret}|${agents.get(n)}`).update(payload).digest('base64url');
    return safeEq(sig, expected) ? n : null;
  } catch { return null; }
}

function normalize(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = cfg.countryCode + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

async function graph(method, p, body) {
  const res = await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${p}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = new Error(data.error?.error_user_msg || data.error?.message || `Graph API ${res.status}`);
    err.code = data.error?.code;
    throw err;
  }
  return data;
}

const FRIENDLY = {
  138006: "Customer hasn't allowed calls yet. Send the permission request first.",
  131047: 'Chat window is closed (24h over). Customer must message first, or use the permission template.',
  131026: "Customer's WhatsApp is outdated or this number isn't on WhatsApp.",
  190: 'WhatsApp token expired or invalid. Update WA_TOKEN on the server.',
};
const friendly = e => ({ error: FRIENDLY[e.code] || e.message, code: e.code || null });

// ---------- live state ----------
const sockets = new Map();      // agent -> Set<WebSocket>
const calls = new Map();        // callId -> call record
const earlyAnswers = new Map(); // callId -> SDP answer that arrived before the API response
const recent = [];              // last finished calls
const logFile = path.join(__dirname, 'data', 'calls.jsonl');
fs.mkdirSync(path.dirname(logFile), { recursive: true });

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const push = (agent, msg) => { for (const ws of sockets.get(agent) || []) send(ws, msg); };
const broadcast = msg => { for (const set of sockets.values()) for (const ws of set) send(ws, msg); };
const onlineAgents = () => [...sockets.entries()].filter(([, s]) => s.size > 0).map(([a]) => a);

function rejectCall(callId) {
  return graph('POST', `${cfg.phoneNumberId}/calls`, { messaging_product: 'whatsapp', call_id: callId, action: 'reject' })
    .catch(e => console.warn('reject failed', callId, e.message));
}

function resultOf(rec, terminateStatus) {
  if (rec.duration > 0) return 'connected';
  if (rec.direction === 'incoming') return rec.status === 'declined' ? 'declined' : 'missed';
  if (rec.sawRejected) return 'rejected';
  if (terminateStatus === 'FAILED') return 'failed';
  return 'not_answered';
}

function finish(rec) {
  const entry = {
    call_id: rec.callId,
    direction: rec.direction,
    customer_number: rec.customer,
    customer_name: rec.customerName || '',
    agent: rec.agent || '',
    result: rec.result,
    duration_seconds: rec.duration || 0,
    started_at: iso(rec.startTime || rec.createdAt),
    ended_at: iso(rec.endTime || Date.now()),
    business_phone_number_id: cfg.phoneNumberId,
  };
  fs.appendFile(logFile, JSON.stringify(entry) + '\n', () => {});
  recent.unshift(entry);
  recent.length = Math.min(recent.length, 500);
  if (cfg.makeWebhook) {
    fetch(cfg.makeWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) })
      .catch(e => console.warn('Make webhook failed:', e.message));
  }
  setTimeout(() => calls.delete(rec.callId), 60_000); // late webhooks still find it for a minute
}

// ---------- webhook handlers ----------
async function onCallEvent(c, contacts) {
  const id = c.id;

  // Our outgoing call: WhatsApp sends the SDP answer
  if (c.event === 'connect' && c.direction === 'BUSINESS_INITIATED') {
    const rec = calls.get(id);
    if (!rec) { earlyAnswers.set(id, c.session?.sdp); setTimeout(() => earlyAnswers.delete(id), 60_000); return; }
    rec.status = 'connecting';
    push(rec.agent, { type: 'answer', callId: id, sdp: c.session?.sdp });
    return;
  }

  // Customer is calling us: ring every online telecaller
  if (c.event === 'connect' && c.direction === 'USER_INITIATED') {
    const rec = {
      callId: id, direction: 'incoming', customer: c.from, customerName: contacts[0]?.profile?.name || '',
      agent: null, status: 'ringing', createdAt: Date.now(), offer: c.session?.sdp, declinedBy: new Set(),
    };
    calls.set(id, rec);
    if (onlineAgents().length === 0) { rec.status = 'missed'; await rejectCall(id); return; }
    rec.ringTimer = setTimeout(async () => {
      if (rec.status !== 'ringing') return;
      rec.status = 'missed';
      await rejectCall(id);
      broadcast({ type: 'incoming_closed', callId: id, reason: 'timeout' });
    }, cfg.ringSeconds * 1000);
    broadcast({ type: 'incoming', callId: id, from: rec.customer, name: rec.customerName, sdp: rec.offer });
    return;
  }

  if (c.event === 'terminate') {
    const rec = calls.get(id);
    if (!rec || rec.result) return;
    clearTimeout(rec.ringTimer);
    const st = String(Array.isArray(c.status) ? c.status[0] : c.status || '').toUpperCase();
    rec.duration = Number(c.duration || 0);
    rec.startTime = c.start_time ? Number(c.start_time) * 1000 : null;
    rec.endTime = c.end_time ? Number(c.end_time) * 1000 : Date.now();
    rec.result = resultOf(rec, st);
    if (rec.agent) push(rec.agent, { type: 'ended', callId: id, result: rec.result, duration: rec.duration });
    else broadcast({ type: 'incoming_closed', callId: id, reason: 'ended' });
    finish(rec);
  }
}

function onCallStatus(s) {
  const rec = calls.get(s.id);
  if (!rec) return;
  const st = String(s.status || '').toUpperCase();
  if (st === 'REJECTED') rec.sawRejected = true;
  if (st === 'ACCEPTED') rec.answeredAt = Date.now();
  if (rec.agent) push(rec.agent, { type: 'status', callId: s.id, status: st });
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.verifyToken) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  if (cfg.appSecret) {
    const expected = 'sha256=' + crypto.createHmac('sha256', cfg.appSecret).update(req.body).digest('hex');
    if (!safeEq(req.get('x-hub-signature-256') || '', expected)) return res.sendStatus(401);
  }
  res.sendStatus(200);
  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch { return; }
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      if (ch.field !== 'calls') continue;
      const v = ch.value || {};
      if (v.metadata?.phone_number_id && v.metadata.phone_number_id !== cfg.phoneNumberId) continue;
      for (const c of v.calls || []) onCallEvent(c, v.contacts || []).catch(e => console.error('call event:', e.message));
      for (const s of v.statuses || []) if (s.type === 'call') onCallStatus(s);
    }
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, online: onlineAgents().length }));

function auth(req, res, next) {
  const agent = readToken((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (!agent) return res.status(401).json({ error: 'Sign in again.' });
  req.agent = agent;
  next();
}

app.post('/api/login', async (req, res) => {
  const name = findAgent(req.body?.name);
  if (!name || !safeEq(String(req.body?.pin || ''), agents.get(name))) {
    await sleep(800);
    return res.status(401).json({ error: 'Name or PIN is wrong.' });
  }
  res.json({ token: makeToken(name), name });
});

app.get('/api/config', auth, (req, res) => res.json({ agent: req.agent, hasTemplate: !!cfg.permissionTemplate }));

app.get('/api/permission', auth, async (req, res) => {
  const to = normalize(req.query.to);
  if (!to) return res.status(400).json({ error: 'Enter a valid mobile number.' });
  try {
    const d = await graph('GET', `${cfg.phoneNumberId}/call_permissions?user_wa_id=${to}`);
    const act = n => (d.actions || []).find(a => a.action_name === n) || {};
    res.json({
      to,
      status: d.permission?.status || 'no_permission', // no_permission | temporary | permanent
      expiresAt: d.permission?.expiration_time || null,
      canRequest: act('send_call_permission_request').can_perform_action ?? true,
      canCall: act('start_call').can_perform_action ?? true,
      requestLimits: act('send_call_permission_request').limits || [],
      callLimits: act('start_call').limits || [],
    });
  } catch (e) { res.status(502).json(friendly(e)); }
});

app.post('/api/permission-request', auth, async (req, res) => {
  const to = normalize(req.body?.to);
  if (!to) return res.status(400).json({ error: 'Enter a valid mobile number.' });
  const useTemplate = req.body?.mode === 'template';
  if (useTemplate && !cfg.permissionTemplate) return res.status(400).json({ error: 'No permission template set on the server.' });
  const message = useTemplate
    ? { type: 'template', template: { name: cfg.permissionTemplate, language: { code: cfg.permissionTemplateLang } } }
    : { type: 'interactive', interactive: { type: 'call_permission_request', action: { name: 'call_permission_request' }, body: { text: cfg.permissionText } } };
  try {
    await graph('POST', `${cfg.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message });
    res.json({ sent: useTemplate ? 'template' : 'message', to });
  } catch (e) { res.status(502).json(friendly(e)); }
});

app.post('/api/call', auth, async (req, res) => {
  const to = normalize(req.body?.to);
  const sdp = req.body?.sdp;
  if (!to || !sdp) return res.status(400).json({ error: 'Number and audio offer are required.' });
  try {
    const d = await graph('POST', `${cfg.phoneNumberId}/calls`, {
      messaging_product: 'whatsapp', to, action: 'connect',
      session: { sdp_type: 'offer', sdp },
      biz_opaque_callback_data: `agent=${req.agent}`.slice(0, 512),
    });
    const callId = d.calls?.[0]?.id;
    if (!callId) throw new Error('WhatsApp did not return a call ID.');
    calls.set(callId, {
      callId, direction: 'outgoing', customer: to, customerName: String(req.body?.name || '').slice(0, 80),
      agent: req.agent, status: 'calling', createdAt: Date.now(),
    });
    const answer = earlyAnswers.get(callId) || null;
    earlyAnswers.delete(callId);
    res.json({ callId, answer });
  } catch (e) { res.status(502).json(friendly(e)); }
});

app.post('/api/hangup', auth, async (req, res) => {
  const callId = req.body?.callId;
  if (calls.has(callId)) {
    await graph('POST', `${cfg.phoneNumberId}/calls`, { messaging_product: 'whatsapp', call_id: callId, action: 'terminate' })
      .catch(() => {}); // already ended on the customer side
  }
  res.json({ ok: true });
});

app.post('/api/accept', auth, async (req, res) => {
  const { callId, sdp } = req.body || {};
  const rec = calls.get(callId);
  if (!rec || rec.direction !== 'incoming' || rec.status !== 'ringing') return res.status(409).json({ error: 'This call is no longer ringing.' });
  rec.agent = req.agent;
  rec.status = 'answering';
  clearTimeout(rec.ringTimer);
  broadcast({ type: 'incoming_closed', callId, reason: 'taken', by: req.agent });
  try {
    const base = { messaging_product: 'whatsapp', call_id: callId, session: { sdp_type: 'answer', sdp } };
    await graph('POST', `${cfg.phoneNumberId}/calls`, { ...base, action: 'pre_accept' });
    await graph('POST', `${cfg.phoneNumberId}/calls`, { ...base, action: 'accept', biz_opaque_callback_data: `agent=${req.agent}` });
    rec.status = 'connected';
    res.json({ ok: true });
  } catch (e) {
    rec.status = 'missed';
    res.status(502).json(friendly(e));
  }
});

app.post('/api/decline', auth, async (req, res) => {
  const rec = calls.get(req.body?.callId);
  if (rec && rec.direction === 'incoming' && rec.status === 'ringing') {
    rec.declinedBy.add(req.agent);
    if (onlineAgents().every(a => rec.declinedBy.has(a))) {
      rec.status = 'declined';
      clearTimeout(rec.ringTimer);
      await rejectCall(rec.callId);
      broadcast({ type: 'incoming_closed', callId: rec.callId, reason: 'declined' });
    }
  }
  res.json({ ok: true });
});

app.get('/api/calls', auth, (req, res) => {
  res.json(recent.filter(e => e.agent === req.agent || (e.direction === 'incoming' && !e.agent)).slice(0, 25));
});

// ---------- WebSocket (server -> browser push) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const agent = readToken(new URL(req.url, 'http://local').searchParams.get('token'));
  if (!agent) return ws.close(4001, 'auth');
  ws.isAlive = true;
  if (!sockets.has(agent)) sockets.set(agent, new Set());
  sockets.get(agent).add(ws);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => sockets.get(agent)?.delete(ws));
  send(ws, { type: 'hello', agent });
  for (const r of calls.values()) {
    if (r.direction === 'incoming' && r.status === 'ringing' && !r.declinedBy.has(agent)) {
      send(ws, { type: 'incoming', callId: r.callId, from: r.customer, name: r.customerName, sdp: r.offer });
    }
  }
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

server.listen(cfg.port, () => console.log(`SleepUp WhatsApp dialer running on :${cfg.port}`));
