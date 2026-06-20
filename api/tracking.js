// Función de Vercel: guarda/lee tu REGISTRO (marcas ✅/❌, cuotas) en la nube,
// para que se sincronice entre tu ordenador y tu móvil con un "código".
// Usa una base de datos Redis (Vercel KV / Upstash). Variables de entorno:
//   KV_REST_API_URL / KV_REST_API_TOKEN   (las pone Vercel al conectar un KV)
//   o UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//
// GET  /api/tracking?key=MICODIGO        -> devuelve { data: {...} }
// POST /api/tracking?key=MICODIGO  body  -> guarda ese JSON

const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function redis(cmd){
  return fetch(DB_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${DB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  }).then(r => r.json());
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!DB_URL || !DB_TOKEN) {
    return res.status(500).json({ error: 'Falta configurar la base de datos en Vercel (KV/Upstash). Mira la guía.' });
  }
  const u = new URL(req.url, 'http://x');
  const raw = (u.searchParams.get('key') || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  if (!raw) return res.status(400).json({ error: 'Falta el código de sincronización.' });
  const key = 'ttedge_track_' + raw;

  try {
    if (req.method === 'POST') {
      let body = '';
      await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
      if (body.length > 800000) return res.status(413).json({ error: 'Registro demasiado grande.' });
      await redis(['SET', key, body || '{}']);
      return res.status(200).json({ ok: true });
    } else {
      const j = await redis(['GET', key]);
      let data = {};
      try { data = JSON.parse(j.result || '{}'); } catch (e) {}
      return res.status(200).json({ data });
    }
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
