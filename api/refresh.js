// Función de Vercel: dispara el robot (workflow de GitHub) bajo demanda.
// La clave de GitHub vive como variable de entorno en Vercel (NO se expone al navegador).
// Variables de entorno necesarias en Vercel:
//   GH_PAT   token fino de GitHub con permiso "Actions: Read and write" sobre tu repo
//   GH_REPO  tu repo en formato  usuario/ttedge
//   GH_REF   (opcional) rama; por defecto "main"
module.exports = async (req, res) => {
  const token = process.env.GH_PAT;
  const repo  = process.env.GH_REPO;
  const ref   = process.env.GH_REF || 'main';
  if (!token || !repo) {
    return res.status(500).json({ ok:false, error:'Falta configurar GH_PAT y GH_REPO en Vercel.' });
  }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/daily.yml/dispatches`, {
      method:'POST',
      headers:{
        'Authorization':`Bearer ${token}`,
        'Accept':'application/vnd.github+json',
        'X-GitHub-Api-Version':'2022-11-28',
        'User-Agent':'ttedge-dashboard'
      },
      body: JSON.stringify({ ref })
    });
    if (r.status === 204) return res.status(200).json({ ok:true });
    const detail = await r.text();
    return res.status(502).json({ ok:false, error:`GitHub respondió ${r.status}`, detail: detail.slice(0,300) });
  } catch (e) {
    return res.status(502).json({ ok:false, error: e.message });
  }
};
