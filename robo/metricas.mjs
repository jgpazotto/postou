// =====================================================================
// POSTOU · Robô de MÉTRICAS — anota os seguidores 1x por dia
// Lê as páginas conectadas (conexoes_meta) e grava em metricas_auto:
//   Instagram: seguidores + nº de posts · Facebook: seguidores da página
// Roda pelo GitHub Actions (.github/workflows/metricas.yml)
// =====================================================================
const GRAPH = 'https://graph.facebook.com/' + (process.env.META_GRAPH_VERSION || 'v23.0');
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const log = (...a) => console.log(new Date().toISOString(), ...a);

function sbHeaders(extra = {}) {
  const h = { apikey: SB_KEY, 'Content-Type': 'application/json', ...extra };
  if (SB_KEY.startsWith('eyJ')) h.Authorization = 'Bearer ' + SB_KEY;
  return h;
}
async function sb(path, opts = {}) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, { ...opts, headers: sbHeaders(opts.headers) });
  const txt = await r.text(); let body = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
  return { ok: r.ok, status: r.status, body };
}
async function graph(path, params) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url); const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return j;
}

const dia = new Date().toISOString().slice(0, 10);
const r = await sb('conexoes_meta?select=user_id,paginas');
if (!r.ok) { log('⚠️ não consegui ler conexoes_meta', r.status, r.body); process.exit(1); }
const linhas = [];
for (const c of r.body || []) {
  for (const p of c.paginas || []) {
    if (!p.token) { log('⏭ sem token ainda:', p.name); continue; }
    const linha = { user_id: c.user_id, page_id: p.id, dia, ig_user: p.ig_user || null, ig_seguidores: null, ig_posts: null, fb_seguidores: null };
    try {
      if (p.ig_id) {
        const ig = await graph('/' + p.ig_id, { fields: 'followers_count,media_count,username', access_token: p.token });
        linha.ig_seguidores = ig.followers_count ?? null; linha.ig_posts = ig.media_count ?? null; linha.ig_user = ig.username || linha.ig_user;
      }
    } catch (e) { log('⚠️ IG', p.name, e.message); }
    try {
      const fb = await graph('/' + p.id, { fields: 'followers_count,fan_count', access_token: p.token });
      linha.fb_seguidores = fb.followers_count ?? fb.fan_count ?? null;
    } catch (e) { log('⚠️ FB', p.name, e.message); }
    if (linha.ig_seguidores != null || linha.fb_seguidores != null) {
      linhas.push(linha);
      log('📈', p.name, linha.ig_user ? '@' + linha.ig_user + ' IG ' + linha.ig_seguidores : '', 'FB', linha.fb_seguidores);
    }
  }
}
if (linhas.length) {
  const w = await sb('metricas_auto?on_conflict=user_id,page_id,dia', { method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(linhas) });
  log(w.ok ? '✅ gravei ' + linhas.length + ' linha(s)' : '⚠️ erro ao gravar ' + w.status + ' ' + JSON.stringify(w.body));
  if (!w.ok) process.exit(1);
} else log('Nada pra gravar.');
