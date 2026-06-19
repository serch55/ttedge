# TT Edge · Registro Ultra (Over/Under) — auto-diario en Vercel

Web que cada día a las **08:00 (hora España)** guarda las predicciones **Ultra (★★★★)** Over y Under de
TT Edge (todas las ligas, en hora española) en un **histórico que crece**. Tú marcas el resultado
(✅ acertó / ❌ falló) y metes la cuota, y la web te lleva las **estadísticas de acierto** y el P/L en unidades.
Se actualiza sola (GitHub Actions inicia sesión, extrae y publica; Vercel muestra la web).

> ⚠️ Esto reutiliza tu sesión de TT Edge y republica sus predicciones. Úsalo para ti.
> El acceso a TT Edge es con Google; por eso el robot no "inicia sesión", sino que usa tu sesión guardada (ver paso 2).

## Qué hay aquí
```
public/index.html         La web (registro + estadísticas; lee public/data/history.json)
public/data/history.json  Histórico de predicciones (el robot AÑADE las de cada día, no borra)
scraper/scrape-ttedge.js  El robot (Playwright): login + Over/Under Ultra → history.json
.github/workflows/daily.yml  El programador diario a las 08:00 ES (GitHub Actions)
vercel.json               Config de Vercel (sirve la carpeta public)
```

## Cómo usar el registro
- Cada día aparecen los nuevos partidos Ultra (Over/Under). Filtra por tipo, liga, fecha o estado.
- En cada tarjeta: pon la **cuota** (botón "🔎 buscar cuota" abre una búsqueda para encontrarla) y marca
  **✅ Acertó** o **❌ Falló** cuando termine el partido.
- Arriba ves las **estadísticas**: % de acierto total, por Over, por Under, y unidades ganadas/perdidas.
- Tus marcas se guardan en **tu navegador**. Usa **⬇ Backup** para guardarlas y **⬆ Restaurar** para recuperarlas.

## Botón "🔄 Forzar actualización" (opcional)
La web trae un botón para lanzar el robot cuando quieras, sin esperar a las 08:00. Lo sirve la función
`api/refresh.js`. Para activarlo, en **Vercel → Settings → Environment Variables** añade:
- `GH_PAT` → un token fino de GitHub con permiso **Actions: Read and write** sobre tu repo.
- `GH_REPO` → tu repo, formato `usuario/ttedge`.

Luego **Redeploy** en Vercel. (Pasos detallados con clics en la guía `GUIA-montar-ttedge.html`, Fase 6.)

### Sobre la cuota automática
La cuota de Over/Under de tenis de mesa no la publican gratis sitios como Sofascore/Flashscore (solo
ganador del partido), así que se mete a mano. El enlace "🔎 buscar cuota" te lleva directo a buscarla.

## Puesta en marcha (una vez)

### 1) Sube esto a un repositorio de GitHub
- Crea una cuenta en github.com si no tienes.
- Crea un repositorio nuevo (p. ej. `ttedge-dashboard`).
- Sube **todo el contenido de esta carpeta** (puedes arrastrar los archivos en la web de GitHub, botón "Add file → Upload files", o usar GitHub Desktop).

### 2) Pon tu SESIÓN de TT Edge como "secret"
TT Edge se entra **con Google**, y eso no se puede automatizar. En su lugar el robot reutiliza tu sesión.
Solo tienes que copiarla una vez:

1. Abre **ttedge.ai** en tu navegador y asegúrate de tener la sesión iniciada.
2. Abre la consola del navegador (F12 → pestaña **Console**).
3. Pega esto y pulsa Enter (copia tu token al portapapeles, **sin enseñártelo a nadie**):
   ```js
   copy(localStorage.getItem('sb-oczzfazrwovcthzslurd-auth-token'))
   ```
4. En tu repo de GitHub: **Settings → Secrets and variables → Actions → New repository secret**
   - Nombre: `TTEDGE_SESSION`
   - Valor: **pega** (Ctrl/Cmd+V) lo que copiaste.

> ℹ️ Esa sesión puede caducar con el tiempo. Si un día el robot falla con "Sesión no válida/expirada"
> (lo verás en Actions, y el sitio dejará de actualizarse), repite los pasos 1-4 para refrescar el secret.
> Si te pasa muy a menudo, dímelo y le añado renovación automática.

### 3) Prueba el robot
- Pestaña **Actions** del repo → activa los workflows si te lo pide.
- Abre "Actualizar predicciones TT Edge (diario)" → botón **Run workflow**.
- Si va bien, actualizará `public/data/predictions.json`. Si falla, descarga el artefacto
  `debug-screenshot` para ver qué pasó (normalmente login/captcha).

### 4) Publica en Vercel
- Entra en vercel.com con tu GitHub.
- **Add New → Project → Import** tu repositorio.
- Framework Preset: **Other** (el `vercel.json` ya configura que sirva `public`).
- **Deploy**. Tu web queda en `https://tu-proyecto.vercel.app`.

A partir de aquí: cada día el robot actualiza el JSON y lo sube; Vercel redespliega solo.
Tu web siempre muestra las predicciones Ultra del día. **Sin depender de nada local ni de Claude.**

## Ajustes
- **Hora de actualización**: edita el `cron` en `.github/workflows/daily.yml`
  (está en UTC; `0 6 * * *` = 08:00 España en verano). Conviene ponerla cuando TT Edge ya tenga
  las predicciones del día sincronizadas.
- **Desfase horario**: el secret/variable `TTEDGE_TZ_OFFSET` (por defecto 6) ajusta a hora española.

## Probar el robot en tu ordenador (opcional)
```
cd ttedge-vercel
npm install
npx playwright install chromium
TTEDGE_SESSION='PEGA_AQUI_TU_TOKEN' node scraper/scrape-ttedge.js --show
```
`--show` abre el navegador para que veas el proceso.

---
*Análisis informativo, no es consejo de apuesta. Juega con responsabilidad. +18.*
