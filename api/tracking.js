// Función de Vercel: guarda/lee tu REGISTRO (marcas ✅/❌, cuotas) en la nube,
// para sincronizarlo entre tu ordenador y tu móvil con un "código".
//
// Funciona con SUPABASE (recomendado, gratis) o, si lo prefieres, con Vercel KV/Upstash.
//
// Variables de entorno en Vercel:
//   SUPABASE_URL   https://xxxx.supabase.co   (Project URL)
//   SUPABASE_KEY   la clave service_role (Settings -> API)  [secreta, solo en el servidor]
//   (alternativa KV: KV_REST_API_URL / KV_REST_API_TOKEN)
//
// Necesita una tabla en Supabase (SQL en la guía):
//   create table tracking ( code text primary key, data jsonb, updated_at timestamptz default now() );
//
// GET  /api/tracking?key=MICODIGO        -> { data: {...} }
// POST /api/tracking?key=MICODIGO  body  -> guarda ese JSON

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

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
function kv(cmd){
  return fetch(KV_URL, { method:'POST', headers:{ Authorization:`Bearer ${KV_TOKEN}`, 'Content-Type':'application/json' }, body: JSON.stringify(cmd) }).then(r=>r.json());
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const useSB = SB_URL && SB_KEY;
  const useKV = KV_URL && KV_TOKEN;
  if (!useSB && !useKV) return res.status(500).json({ error: 'Falta configurar la base de datos (Supabase o KV) en Vercel. Mira la guía.' });

  const u = new URL(req.url, 'http://x');
  const code = (u.searchParams.get('key') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  if (!code) return res.status(400).json({ error: 'Falta el código de sincronización.' });

  try {
    if (req.method === 'POST') {
      let body = '';
      await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
      if (body.length > 800000) return res.status(413).json({ error: 'Registro demasiado grande.' });
      let data = {}; try { data = JSON.parse(body || '{}'); } catch (e) {}
      if (useSB) await sbSet(code, data);
      else await kv(['SET', 'ttedge_track_' + code, body || '{}']);
      return res.status(200).json({ ok: true });
    } else {
      let data = {};
      if (useSB) data = await sbGet(code);
      else { const j = await kv(['GET', 'ttedge_track_' + code]); try { data = JSON.parse(j.result || '{}'); } catch (e) {} }
      return res.status(200).json({ data });
    }
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
