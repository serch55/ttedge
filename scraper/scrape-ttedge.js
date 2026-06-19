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

// Login automático en TT Edge (Supabase, email+contraseña). Sin caducidad: inicia sesión cada vez.
const EMAIL = process.env.TTEDGE_EMAIL || '';
const PASSWORD = process.env.TTEDGE_PASSWORD || '';
const SUPA_URL = 'https://oczzfazrwovcthzslurd.supabase.co';        // proyecto Supabase de ttedge.ai
const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jenpmYXpyd292Y3RoenNsdXJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxNzY5NjYsImV4cCI6MjA4MTc1Mjk2Nn0.1-5W6TiOgajBoJgBkd1JBxwLG13eXwBAx-_GSLN3tzo'; // clave pública (anon)
const SUPA_KEY = 'sb-oczzfazrwovcthzslurd-auth-token';             // clave de localStorage donde va la sesión
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
  // un bloque es "tarjeta" si tiene ★ + H2H + vs + (OVER|UNDER|SPREAD); cogemos el mínimo que lo tenga todo
  const ok = j => /★/.test(j) && /H2H/.test(j) && /\bvs\b/i.test(j) && /\b(OVER|UNDER|SPREAD)\b/i.test(j);
  const all=[...document.querySelectorAll('div')];
  const cards=[];
  for(const el of all){
    const tks=tokensOf(el); const joined=tks.join(' | ');
    if(!ok(joined)) continue;
    if([...el.children].some(c=>ok(tokensOf(c).join(' | ')))) continue;
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
    const timeRaw = timeM ? timeM[1].replace(/\s+/g,' ') : '';
    const h2h = (joined.match(/(\d+)\s*\|?\s*H2H/)||[])[1] || '';
    const score = (joined.match(/Score:[^\d]*(\d+)/)||[])[1] || '';
    const trend = /rising/i.test(joined) ? 'rising' : (/falling/i.test(joined) ? 'falling' : '');
    const tags = ['Hot Streak','Fatigue','Volatile','Pattern'].filter(t=>new RegExp(t,'i').test(joined));
    if(!home || !away) continue;
    const base = { stars, league, home, away, timeRaw, score: score?+score:null, h2h: h2h?+h2h:null, trend, tags };

    if (/\bSPREAD\b/i.test(joined)) {
      // SPREAD: jugador favorito + hándicap. Ej: "→ | Denys Kozoriz | SPREAD | - | 14.5 | (L5: | 13.6"
      const pickM = joined.match(/→\s*\|?\s*([^|]+?)\s*\|\s*SPREAD/i);
      const spM = joined.match(/SPREAD\s*\|?\s*([+-]?)\s*\|?\s*(\d+\.?\d*)/i);
      const l5s = (joined.match(/L5:[^\d-]*(\d+\.?\d*)/)||[])[1] || '';
      const spread = spM ? (spM[1]==='-'?-1:1)*parseFloat(spM[2]) : null;
      out.push({ ...base, type:'spread', pick: pickM?pickM[1].trim():'', spread, l5: l5s?parseFloat(l5s):null });
    } else {
      // OVER/UNDER: número y "%" son tokens separados (".. | 87 | % | .."), por eso [^\d]* y sin %
      const predM = joined.match(/\b(OVER|UNDER)\b[^\d]*(\d+)/i);
      const l5 = (joined.match(/L5:[^\d]*(\d+)/)||[])[1] || '';
      const sets3 = (joined.match(/3\+ sets:[^\d]*(\d+)/)||[])[1] || '';
      if(!predM) continue;
      out.push({ ...base, type: predM[1].toLowerCase(), pct:+predM[2], l5: l5?+l5:null, sets3: sets3?+sets3:null });
    }
  }
  return out;
}

async function applyFilters(page, type){
  // estado por defecto tras recarga: Ultra + High activos, sin tipo
  await page.goto('https://ttedge.ai/edge-finder', { waitUntil:'domcontentloaded', timeout:60000 });
  // ESPERAR a que la SPA cargue las predicciones (en servidor tarda: app + Supabase + datos)
  try { await page.waitForFunction(()=>{ const t=document.body?document.body.textContent:''; return /H2H/.test(t) && /★/.test(t); }, { timeout:40000 }); }
  catch(e){ /* seguimos, puede que solo tarde un poco más */ }
  await page.waitForTimeout(2000);
  const clickExact = async (label) => page.evaluate((lbl)=>{
    const els=[...document.querySelectorAll('button,a,[role="button"],div,span,label')];
    const c=els.filter(e=>(e.textContent||'').trim()===lbl).sort((a,b)=>a.textContent.length-b.textContent.length);
    if(c[0]){ c[0].click(); return true; } return false;
  }, label);
  const btnLabel = type==='over'?'Over':type==='under'?'Under':'Spread';
  await clickExact(btnLabel);                              // marca el tipo
  await page.waitForTimeout(1000);
  await clickExact('High');                                // quita High -> solo Ultra
  await page.waitForTimeout(2500);
  let rows = await page.evaluate(pageExtract);
  // reintento si aún no había cargado
  if(rows.length === 0){ await page.waitForTimeout(5000); rows = await page.evaluate(pageExtract); }
  // por seguridad, solo Ultra (4 estrellas) del tipo pedido
  rows = rows.filter(r => r.stars === 4 && r.type === type);
  return rows;
}

async function injectSession(page){
  // 1) LOGIN automático contra Supabase con email+contraseña (sin navegador, sin caducidad)
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method:'POST',
    headers:{ 'apikey': SUPA_ANON, 'Content-Type':'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  const session = await res.json().catch(()=>({}));
  if (!res.ok || !session.access_token) {
    throw new Error('Login falló ('+res.status+'). ¿Email/contraseña correctos en los secrets TTEDGE_EMAIL/TTEDGE_PASSWORD? Detalle: '+JSON.stringify(session).slice(0,160));
  }
  // 2) cargar el dominio e inyectar la sesión recién creada en su localStorage
  await page.goto('https://ttedge.ai/', { waitUntil:'domcontentloaded', timeout:60000 });
  await page.evaluate(({k,v})=>{ try{ localStorage.setItem(k, v); }catch(e){} }, { k:SUPA_KEY, v: JSON.stringify(session) });
  // 3) entrar ya logueado
  await page.goto('https://ttedge.ai/edge-finder', { waitUntil:'domcontentloaded', timeout:60000 });
  await page.waitForTimeout(4000);
  if (/\/auth/.test(page.url())) throw new Error('La sesión creada no fue aceptada por la web (formato).');
  try { await page.waitForFunction(()=>{ const t=document.body?document.body.textContent:''; return /H2H/.test(t) || /\/auth/.test(location.pathname); }, { timeout:30000 }); } catch(e){}
  if (/\/auth/.test(page.url())) throw new Error('Login OK pero la web no cargó las predicciones (¿plan/trial caducado en TT Edge?).');
}

(async () => {
  if(!EMAIL || !PASSWORD){ console.error('\n❌ Faltan TTEDGE_EMAIL / TTEDGE_PASSWORD (tu acceso a TT Edge). Mira el README.\n'); process.exit(1); }
  const browser = await chromium.launch({ headless: !SHOW, args:['--disable-blink-features=AutomationControlled','--no-sandbox'] });
  const ctx = await browser.newContext({
    userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:{ width:1280, height:2200 }, locale:'en-US'
  });
  const page = await ctx.newPage();
  try {
    console.log('🔐 Inyectando sesión de TT Edge…');
    await injectSession(page);
    // DIAGNÓSTICO: ¿qué ve el robot tras inyectar la sesión?
    const diag = await page.evaluate(()=>{
      const t = document.body ? document.body.textContent : '';
      return {
        url: location.href,
        textoLen: t.length,
        hayPredicciones: /H2H/.test(t),
        estrellas: (t.match(/★/g)||[]).length,
        pareceLogin: /(log\s?in|sign\s?in|continue with google)/i.test(t),
        botonesFiltro: ['Over','Under','High','Ultra'].filter(w=>new RegExp('(^|\\s)'+w+'(\\s|$)').test(t)),
        snippet: t.replace(/\s+/g,' ').slice(0,260)
      };
    }).catch(e=>({error:e.message}));
    console.log('🔎 diag:', JSON.stringify(diag));

    console.log('📥 Extrayendo OVER (Ultra)…');
    const over = await applyFilters(page, 'over');
    console.log(`   ${over.length} partidos OVER`);
    console.log('📥 Extrayendo UNDER (Ultra)…');
    const under = await applyFilters(page, 'under');
    console.log(`   ${under.length} partidos UNDER`);
    console.log('📥 Extrayendo SPREAD (Ultra)…');
    const spread = await applyFilters(page, 'spread');
    console.log(`   ${spread.length} partidos SPREAD`);

    const day = todayMadrid();
    const todays = [...over, ...under, ...spread].map(r => {
      const id = `${day}_${r.type}_${slug(r.home)}_vs_${slug(r.away)}`;
      return {
        id, date: day, type: r.type, home: r.home, away: r.away, league: r.league,
        time: toES(r.timeRaw), timeRaw: r.timeRaw,
        pct: r.pct, l5: r.l5, sets3: r.sets3, score: r.score,
        pick: r.pick, spread: r.spread,
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
    // diagnóstico legible (se commitea para poder revisarlo)
    fs.writeFileSync(path.join(path.dirname(OUT),'_debug.json'), JSON.stringify({ when:new Date().toISOString(), overFound:over.length, underFound:under.length, spreadFound:spread.length, diag }, null, 2));
    console.log(`💾 ${OUT} · hoy ${todays.length} (${over.length} over, ${under.length} under, ${spread.length} spread) · histórico total ${all.length}.`);
  } catch(e){
    try { fs.mkdirSync(path.dirname(OUT),{recursive:true}); fs.writeFileSync(path.join(path.dirname(OUT),'_debug.png'), await page.screenshot()); } catch(_){}
    console.error('💥 Error:', e.message, '(ver public/data/_debug.png)');
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
