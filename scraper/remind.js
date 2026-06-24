'use strict';
/**
 * remind.js — Envía a Telegram un recordatorio ~30 min antes de cada partido
 * que ya se avisó previamente al canal (los marcados con tgSent).
 *
 * Ligero: NO abre navegador. Solo lee public/data/history.json, mira la hora
 * española actual y avisa de los partidos que empiezan dentro de ~20-40 min
 * y que aún no tienen recordatorio (tgReminded). Marca tgReminded para no repetir.
 *
 * Pensado para correr cada ~10 min en GitHub Actions. Secrets:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'public', 'data', 'history.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID  || '';

// Ventana objetivo (minutos antes del partido). Centrada en 30, con margen por
// si la ejecución de GitHub se retrasa. Un partido se avisa una sola vez.
const MIN_BEFORE = 20;
const MAX_BEFORE = 40;

// "Ahora" como reloj de pared de Madrid, representado como Date naíf (mismo marco
// que matchDT abajo), para que la RESTA entre ambos sea correcta sin liarse con TZ.
function madridNowNaive(){
  const f = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const p = {}; for (const part of f.formatToParts(new Date())) if (part.type!=='literal') p[part.type]=part.value;
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}
function matchNaive(dateStr, timeStr){
  if(!dateStr || !/^\d{2}:\d{2}$/.test(timeStr||'')) return null;
  return new Date(`${dateStr}T${timeStr}:00Z`);
}

function betLine(m){
  if (m.type === 'spread') {
    const h = (m.spread!=null) ? String(m.spread).replace('.',',') : '';
    return `SPREAD · ${m.pick||''} ${h}`.trim();
  }
  const linea = m.type === 'under' ? 'UNDER 71,5' : 'OVER 77,5';
  const extra = (m.pct!=null) ? ` (${m.pct}%${m.l5!=null?` · L5 ${m.l5}%`:''})` : '';
  return linea + extra;
}
function reminderText(m, mins){
  return `⏰ Empieza en ~${mins} min\n🏓 TT Elite · ${m.time}\n${m.home} vs ${m.away}\n${betLine(m)}\n⭐ Score ${m.score}`;
}
async function sendTelegram(text){
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview:true })
  });
  return r.ok;
}

(async () => {
  if (!TG_TOKEN || !TG_CHAT) { console.log('📨 Telegram desactivado (faltan secrets).'); return; }
  let hist;
  try { hist = JSON.parse(fs.readFileSync(OUT,'utf8')); } catch(e){ console.error('No pude leer history.json'); return; }
  const now = madridNowNaive();
  let sent = 0;

  for (const m of (hist.matches||[])) {
    if (!m.tgSent || m.tgReminded) continue;       // solo los ya avisados y sin recordatorio
    let dt = matchNaive(m.date, m.time);
    if (!dt) continue;
    let diffMin = (dt - now) / 60000;
    // Si quedó muy en el pasado, seguramente cruzó medianoche (ej. 6PM TT Edge -> 00:00 ES del día siguiente)
    if (diffMin < -180) { dt = new Date(dt.getTime() + 24*60*60*1000); diffMin = (dt - now) / 60000; }
    if (diffMin >= MIN_BEFORE && diffMin <= MAX_BEFORE) {
      try {
        if (await sendTelegram(reminderText(m, Math.round(diffMin)))) { m.tgReminded = true; sent++; await new Promise(r=>setTimeout(r,400)); }
      } catch(e){ console.error('Telegram error:', e.message); }
    }
  }

  if (sent > 0) {
    fs.writeFileSync(OUT, JSON.stringify(hist, null, 2));
    console.log(`📨 Recordatorios enviados: ${sent}.`);
  } else {
    console.log('📨 Sin recordatorios que enviar ahora.');
  }
})();
