// Función de Vercel: AVISOS a Telegram, disparada por un cron externo (cron-job.org)
// cada ~2 min. Es puntual (no depende del cron de GitHub Actions).
//
// Hace dos cosas:
//   1) NUEVA APUESTA: avisa de cada partido nuevo (TT Elite / Czech Liga Pro) que aún
//      no empezó y no se haya avisado.
//   2) RECORDATORIO: ~30 min antes del inicio, avisa otra vez.
//
// Guarda el estado de "ya avisado" en Supabase (tabla tracking, code '__notify__'),
// así no repite aunque se llame cada 2 minutos.
//
// Variables de entorno en Vercel:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, SUPABASE_URL, SUPABASE_KEY

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID  || '';

const STATE_CODE = '__notify__';
const LEAGUES = ['TT Elite Series', 'Czech Liga Pro'];
const MIN_BEFORE = 20, MAX_BEFORE = 40;   // ventana del recordatorio (objetivo 30 min)
const MAX_SENDS = 12;                      // tope de mensajes por llamada (evita timeouts)

async function sbGet(code){
  const r = await fetch(`${SB_URL}/rest/v1/tracking?code=eq.${encodeURIComponent(code)}&select=data`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  const a = await r.json();
  return (Array.isArray(a) && a[0] && a[0].data) ? a[0].data : {};
}
async function sbSet(code, data){
  await fetch(`${SB_URL}/rest/v1/tracking`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ code, data, updated_at: new Date().toISOString() })
  });
}

function madridNowNaive(){
  const f = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const p = {}; for (const part of f.formatToParts(new Date())) if (part.type!=='literal') p[part.type]=part.value;
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}
function matchNaive(dateStr, timeStr){
  if(!dateStr || !/^\d{2}:\d{2}$/.test(timeStr||'')) return null;
  let dt = new Date(`${dateStr}T${timeStr}:00Z`);
  if (parseInt(timeStr.slice(0,2),10) < 6) dt = new Date(dt.getTime() + 24*3600*1000); // cruza medianoche
  return dt;
}
const lgShort = l => l==='TT Elite Series' ? 'TT Elite' : l==='Czech Liga Pro' ? 'Liga Pro' : l;
function betLine(m){
  if (m.type === 'spread') { const h=(m.spread!=null)?String(m.spread).replace('.',','):''; return `SPREAD · ${m.pick||''} ${h}`.trim(); }
  const linea = m.type === 'under' ? 'UNDER 71,5' : 'OVER 77,5';
  const extra = (m.pct!=null) ? ` (${m.pct}%${m.l5!=null?` · L5 ${m.l5}%`:''})` : '';
  return linea + extra;
}
function newText(m){ return `🆕 Nueva apuesta\n🏓 ${lgShort(m.league)} · ${m.time}\n${m.home} vs ${m.away}\n${betLine(m)}${m.score!=null?`\n⭐ Score ${m.score}`:''}`; }
function remindText(m, mins){ return `⏰ Empieza en ~${mins} min\n🏓 ${lgShort(m.league)} · ${m.time}\n${m.home} vs ${m.away}\n${betLine(m)}`; }
async function tg(text, replyTo){
  const body = { chat_id: TG_CHAT, text, disable_web_page_preview:true };
  // Si se pasa replyTo NO ponemos allow_sending_without_reply: así, si el mensaje
  // original no existe, Telegram falla (ok:false) y el llamante manda el completo.
  if (replyTo) body.reply_to_message_id = replyTo;
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  let j = null; try { j = await r.json(); } catch(e){}
  return { ok: !!(r.ok && j && j.ok), message_id: (j && j.result) ? j.result.message_id : null };
}
const qualify = m => LEAGUES.includes(m.league) && !(m.type==='spread' && (m.conf||'ultra')==='high');

module.exports = async (req, res) => {
  if (!TG_TOKEN || !TG_CHAT) return res.status(200).json({ skip: 'faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID en Vercel' });
  if (!SB_URL || !SB_KEY)   return res.status(200).json({ skip: 'faltan SUPABASE_URL / SUPABASE_KEY en Vercel' });

  let hist;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const r = await fetch(`https://${host}/data/history.json?ts=${Date.now()}`, { cache: 'no-store' });
    hist = await r.json();
  } catch (e) { return res.status(502).json({ error: 'no pude leer history.json: ' + e.message }); }

  const state = await sbGet(STATE_CODE);
  state.sent = state.sent || {};
  state.reminded = state.reminded || {};
  state.msgId = state.msgId || {};   // id del mensaje de "nueva apuesta" para responderle luego

  const now = madridNowNaive();
  const ids = new Set();
  let nuevos = 0, recs = 0, sends = 0;

  // PASO 1 (instantáneo, sin enviar): marca los pasados y clasifica lo que hay que enviar.
  const toNew = [], toRemind = [];
  for (const m of (hist.matches || [])) {
    if (!qualify(m)) continue;
    ids.add(m.id);
    const dt = matchNaive(m.date, m.time); if (!dt) continue;
    const diff = (dt - now) / 60000;
    const sent = m.tgSent || state.sent[m.id];
    const reminded = m.tgReminded || state.reminded[m.id];
    if (!sent) {
      if (diff > 0) toNew.push({ m, diff });
      else { state.sent[m.id] = 1; state.reminded[m.id] = 1; }   // pasado: marca sin avisar (no spamea histórico)
    }
    if ((sent || state.sent[m.id]) && !reminded && diff >= MIN_BEFORE && diff <= MAX_BEFORE) toRemind.push({ m, diff });
  }

  // PASO 2 (acotado): primero RECORDATORIOS (sensibles al tiempo), luego NUEVAS; los más próximos primero.
  toRemind.sort((a,b)=>a.diff-b.diff);
  toNew.sort((a,b)=>a.diff-b.diff);
  for (const { m, diff } of toRemind) {
    if (sends >= MAX_SENDS) break;
    try {
      const mins = Math.round(diff);
      let s = { ok:false };
      if (state.msgId[m.id]) s = await tg(`⏰ Empieza en ~${mins} min`, state.msgId[m.id]);  // breve, como respuesta
      if (!s.ok) s = await tg(remindText(m, mins));                                          // fallback: completo
      if (s.ok) { state.reminded[m.id] = 1; recs++; sends++; }
    } catch(e){}
  }
  for (const { m } of toNew) {
    if (sends >= MAX_SENDS) break;
    try { const s = await tg(newText(m)); if (s.ok) { state.sent[m.id] = 1; if (s.message_id) state.msgId[m.id] = s.message_id; nuevos++; sends++; } } catch(e){}
  }

  // poda: conserva solo el estado de partidos que siguen en el histórico
  for (const k of Object.keys(state.sent))     if (!ids.has(k)) delete state.sent[k];
  for (const k of Object.keys(state.reminded)) if (!ids.has(k)) delete state.reminded[k];
  for (const k of Object.keys(state.msgId))    if (!ids.has(k)) delete state.msgId[k];

  try { await sbSet(STATE_CODE, state); } catch(e){}
  return res.status(200).json({ ok: true, nuevos, recordatorios: recs });
};
