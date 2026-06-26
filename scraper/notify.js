'use strict';
/**
 * notify.js — Avisos a Telegram. NO abre navegador: solo lee public/data/history.json.
 *
 * Hace dos cosas en cada ejecución (pensado para correr cada ~10 min):
 *   1) NUEVA APUESTA: avisa de cada partido nuevo (TT Elite o Czech Liga Pro, cualquier
 *      score, todos los días) que aún no empezó y no se haya avisado (marca tgSent).
 *   2) RECORDATORIO: ~30 min antes del inicio, avisa otra vez (marca tgReminded).
 *
 * Maneja bien los partidos que cruzan medianoche: una hora 00:00-05:59 corresponde
 * en realidad al día siguiente (TT Edge 6PM-11PM + 6h = madrugada española).
 *
 * Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'public', 'data', 'history.json');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID  || '';

const LEAGUES = ['TT Elite Series', 'Czech Liga Pro'];   // ligas que se avisan (igual que el html)
const MIN_BEFORE = 20, MAX_BEFORE = 40;                  // ventana del recordatorio (objetivo 30 min)

// "Ahora" como reloj de pared de Madrid, en Date naíf (mismo marco que matchNaive) para restar bien.
function madridNowNaive(){
  const f = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const p = {}; for (const part of f.formatToParts(new Date())) if (part.type!=='literal') p[part.type]=part.value;
  return new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}
function matchNaive(dateStr, timeStr){
  if(!dateStr || !/^\d{2}:\d{2}$/.test(timeStr||'')) return null;
  let dt = new Date(`${dateStr}T${timeStr}:00Z`);
  if (parseInt(timeStr.slice(0,2),10) < 6) dt = new Date(dt.getTime() + 24*3600*1000); // cruzó medianoche
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
async function tg(text){
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview:true })
  });
  return r.ok;
}
const qualify = m => LEAGUES.includes(m.league) && !(m.type==='spread' && (m.conf||'ultra')==='high');

(async () => {
  if (!TG_TOKEN || !TG_CHAT) { console.log('📨 Telegram desactivado (faltan secrets).'); return; }
  let hist;
  try { hist = JSON.parse(fs.readFileSync(OUT,'utf8')); } catch(e){ console.error('No pude leer history.json'); return; }
  const now = madridNowNaive();
  let nuevos = 0, recs = 0;

  for (const m of (hist.matches||[])) {
    if (!qualify(m)) continue;
    const dt = matchNaive(m.date, m.time); if (!dt) continue;
    const diff = (dt - now) / 60000;   // minutos hasta el inicio

    // 1) NUEVA APUESTA (aún no avisada)
    if (!m.tgSent) {
      if (diff > 0) {                  // todavía no empezó -> avisa
        try { if (await tg(newText(m))) { m.tgSent = true; nuevos++; await new Promise(r=>setTimeout(r,350)); } } catch(e){ console.error('TG:', e.message); }
      } else {
        m.tgReminded = true;           // partido ya pasado y nunca avisado: márcalo y no spamees el histórico
        m.tgSent = true;
      }
    }

    // 2) RECORDATORIO ~30 min antes
    if (m.tgSent && !m.tgReminded && diff >= MIN_BEFORE && diff <= MAX_BEFORE) {
      try { if (await tg(remindText(m, Math.round(diff)))) { m.tgReminded = true; recs++; await new Promise(r=>setTimeout(r,350)); } } catch(e){ console.error('TG:', e.message); }
    }
  }

  if (nuevos || recs) fs.writeFileSync(OUT, JSON.stringify(hist, null, 2));
  console.log(`📨 Nuevas: ${nuevos} · Recordatorios: ${recs}`);
})();
