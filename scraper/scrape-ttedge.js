'use strict';
/**
 * scrape-ttedge.js — Reutiliza tu sesión de TT Edge e extrae las predicciones ULTRA (★★★★)
 * de tipo OVER y UNDER, en todas las ligas. Acumula en public/data/history.json.
 *
 * Pensado para correr en GitHub Actions (diario) con Playwright headless.
 * TT Edge entra con Google, así que NO se automatiza el login: se inyecta tu sesión.
 *
 * Secret (NUNCA en el código): variable de entorno
 *   TTEDGE_SESSION   valor de localStorage 'sb-oczzfazrwovcthzslurd-auth-token' (ver README)
 *
 * Uso local de prueba:
 *   TTEDGE_SESSION='...' node scraper/scrape-ttedge.js   (añade --show para ver el navegador)
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// Sesión de TT Edge (Supabase) — login es con Google, así que NO usamos usuario/contraseña:
// inyectamos tu sesión guardada. SESSION = valor de localStorage 'sb-...-auth-token'.
const SESSION = process.env.TTEDGE_SESSION || '';
const SUPA_KEY = 'sb-oczzfazrwovcthzslurd-auth-token'; // clave de sesión Supabase de ttedge.ai
const SHOW = process.argv.includes('--show');
const TZ_OFFSET_H = parseInt(process.env.TTEDGE_TZ_OFFSET || '6', 10); // +6h => hora española
const OUT = path.join(__dirname, '..', 'public', 'data', 'history.json');

// fecha de HOY en zona España (YYYY-MM-DD)
function todayMadrid(){
  const f = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit' });
  return f.format(new Date()); // en-CA da YYYY-MM-DD
}
const slug = s => (s||'').toLowerCase().normalize('NFD').replace(/[^\w]+/g,'-').replace(/^-|-$/g,'');

// "6:05 AM" + offset -> "12:05" (24h)
function toES(timeStr){
  const m = (timeStr||'').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return timeStr || '';
  let h = parseInt(m[1],10) % 12; if (/PM/i.test(m[3])) h += 12;
  let total = (h*60 + parseInt(m[2],10) + TZ_OFFSET_H*60) % (24*60);
  if (total < 0) total += 24*60;
  return String(Math.floor(total/60)).padStart(2,'0') + ':' + String(total%60).padStart(2,'0');
}

// función ejecutada DENTRO de la página: extrae las tarjetas visibles
function pageExtract(){
  const tokensOf = root => { const out=[]; const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null); let n; while(n=w.nextNode()){const t=(n.textContent||'').trim(); if(t)out.push(t);} return out; };
  const all=[...document.querySelectorAll('div')];
  const cards=[];
  for(const el of all){
    const tks=tokensOf(el); const joined=tks.join(' | ');
    if(!/★/.test(joined) || !/H2H/.test(joined) || !/\bvs\b/i.test(joined)) continue;
    const childq=[...el.children].some(c=>{const j=tokensOf(c).join(' | ');return /★/.test(j)&&/H2H/.test(j)&&/\bvs\b/i.test(j);});
    if(childq) continue;
    cards.push(tks);
  }
  const out=[];
  for(const tks of cards){
    const joined = tks.join(' | ');
    const starTok = tks.find(t=>/★/.test(t)) || '';
    const stars = (starTok.match(/★/g)||[]).length;
    const vsIdx = tks.findIndex(t=>/^vs$/i.test(t));
    let home='', away='';
    if(vsIdx>0){ home=tks[vsIdx-1]; away=tks[vsIdx+1]||''; }
    const league = tks[0]||'';
    const timeM = joined.match(/(\d{1,2}:\d{2}\s*(AM|PM))/i);
    const h2h = (joined.match(/(\d+)\s*H2H/)||[])[1] || '';
    const predM = joined.match(/\b(OVER|UNDER)\b[^\d]*(\d+)%/i);
    const l5 = (joined.match(/L5:\s*(\d+)%/)||[])[1] || '';
    const sets3 = (joined.match(/3\+ sets:?\s*\|?\s*(\d+)%/)||[])[1] || '';
    const score = (joined.match(/Score:\s*(\d+)/)||[])[1] || '';
    const trend = /rising/i.test(joined) ? 'rising' : (/falling/i.test(joined) ? 'falling' : '');
    const tags = ['Hot Streak','Fatigue','Volatile','Pattern'].filter(t=>new RegExp(t,'i').test(joined));
    if(!home || !away || !predM) continue;
    out.push({
      stars, league, home, away,
      timeRaw: timeM ? timeM[1].replace(/\s+/g,' ') : '',
      type: predM[1].toLowerCase(), pct: +predM[2],
      l5: l5?+l5:null, sets3: sets3?+sets3:null, score: score?+score:null,
      h2h: h2h?+h2h:null, trend, tags
    });
  }
  return out;
}

async function applyFilters(page, type){
  // estado por defecto tras recarga: Ultra + High activos, sin tipo
  await page.goto('https://ttedge.ai/edge-finder', { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForTimeout(2500);
  const clickExact = async (label) => page.evaluate((lbl)=>{
    const els=[...document.querySelectorAll('button,a,[role="button"],div,span,label')];
    const c=els.filter(e=>(e.textContent||'').trim()===lbl).sort((a,b)=>a.textContent.length-b.textContent.length);
    if(c[0]){ c[0].click(); return true; } return false;
  }, label);
  await clickExact(type === 'over' ? 'Over' : 'Under');   // marca el tipo
  await page.waitForTimeout(600);
  await clickExact('High');                                // quita High -> solo Ultra
  await page.waitForTimeout(1800);
  let rows = await page.evaluate(pageExtract);
  // por seguridad, solo Ultra (4 estrellas) del tipo pedido
  rows = rows.filter(r => r.stars === 4 && r.type === type);
  return rows;
}

async function injectSession(page){
  // 1) cargar el dominio para tener acceso a su localStorage
  await page.goto('https://ttedge.ai/', { waitUntil:'domcontentloaded', timeout:60000 });
  // 2) inyectar la sesión guardada (Supabase la usará y refrescará el token sola)
  await page.evaluate(({k,v})=>{ try{ localStorage.setItem(k, v); }catch(e){} }, { k:SUPA_KEY, v:SESSION });
  // 3) entrar ya logueado
  await page.goto('https://ttedge.ai/edge-finder', { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForTimeout(3000);
  // comprobar que NO nos ha echado al login
  if (/\/auth/.test(page.url())) throw new Error('Sesión no válida/expirada. Vuelve a copiar tu token de TT Edge al secret TTEDGE_SESSION.');
}

(async () => {
  if(!SESSION){ console.error('\n❌ Falta TTEDGE_SESSION (tu token de sesión de TT Edge). Mira el README.\n'); process.exit(1); }
  const browser = await chromium.launch({ headless: !SHOW, args:['--disable-blink-features=AutomationControlled','--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:{ width:1280, height:2200 }, locale:'en-US'
  });
  const page = await ctx.newPage();
  try {
    console.log('🔐 Inyectando sesión de TT Edge…');
    await injectSession(page);
    console.log('📥 Extrayendo OVER (Ultra)…');
    const over = await applyFilters(page, 'over');
    console.log(`   ${over.length} partidos OVER`);
    console.log('📥 Extrayendo UNDER (Ultra)…');
    const under = await applyFilters(page, 'under');
    console.log(`   ${under.length} partidos UNDER`);

    const day = todayMadrid();
    const todays = [...over, ...under].map(r => {
      const id = `${day}_${r.type}_${slug(r.home)}_vs_${slug(r.away)}`;
      return {
        id, date: day, type: r.type, home: r.home, away: r.away, league: r.league,
        time: toES(r.timeRaw), timeRaw: r.timeRaw,
        pct: r.pct, l5: r.l5, sets3: r.sets3, score: r.score,
        h2h: r.h2h, trend: r.trend, tags: r.tags
      };
    });

    if(todays.length === 0){
      try { fs.mkdirSync(path.dirname(OUT),{recursive:true}); fs.writeFileSync(path.join(path.dirname(OUT),'_debug.png'), await page.screenshot()); } catch(e){}
      console.error('⚠️ 0 partidos extraídos. Guardado _debug.png. ¿Login OK? ¿captcha?');
    }

    // MERGE con el histórico existente (no sobrescribe días anteriores; actualiza los de hoy)
    let hist = { matches: [] };
    try { hist = JSON.parse(fs.readFileSync(OUT,'utf8')); } catch(e){}
    const byId = {}; (hist.matches||[]).forEach(m => { byId[m.id] = m; });
    for (const m of todays) byId[m.id] = { ...(byId[m.id]||{}), ...m }; // conserva nada extra, actualiza datos
    const all = Object.values(byId).sort((a,b)=> (b.date+ (b.time||'')).localeCompare(a.date+(a.time||'')));

    const payload = { generated: new Date().toISOString(), tzNote: `hora española (+${TZ_OFFSET_H}h)`, lastDay: day, totalCount: all.length, todayCount: todays.length, matches: all };
    fs.mkdirSync(path.dirname(OUT), { recursive:true });
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
    console.log(`💾 ${OUT} · hoy ${todays.length} (${over.length} over, ${under.length} under) · histórico total ${all.length}.`);
  } catch(e){
    try { fs.mkdirSync(path.dirname(OUT),{recursive:true}); fs.writeFileSync(path.join(path.dirname(OUT),'_debug.png'), await page.screenshot()); } catch(_){}
    console.error('💥 Error:', e.message, '(ver public/data/_debug.png)');
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
