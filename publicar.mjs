// =====================================================================
// POSTOU · Robô de publicação automática (Instagram + Facebook)
// Roda no GitHub Actions a cada 15 minutos (ver .github/workflows/publicar.yml)
// Segredos necessários no GitHub (Settings → Secrets → Actions):
//   SUPABASE_URL          ex.: https://qzdursjwvlzwahemrkmv.supabase.co
//   SUPABASE_SERVICE_KEY  chave "secret"/service_role do Supabase
//   META_APP_ID           1741842040494859
//   META_APP_SECRET       "Chave secreta do app" (Meta for Developers → Configurações → Básico)
// =====================================================================

const GRAPH = 'https://graph.facebook.com/' + (process.env.META_GRAPH_VERSION || 'v23.0');
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const APP_ID = process.env.META_APP_ID || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const JANELA_HORAS = 6;            // só publica posts cujo horário passou há no máximo 6h
const FUSO_PADRAO = 'America/Sao_Paulo';
const REDES_AUTO = ['instagram', 'facebook'];
const SECO = process.argv.includes('--seco'); // modo teste: não publica nada, só mostra

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- Supabase
function sbHeaders(extra = {}) {
  const h = { apikey: SB_KEY, 'Content-Type': 'application/json', ...extra };
  if (SB_KEY.startsWith('eyJ')) h.Authorization = 'Bearer ' + SB_KEY; // chave antiga (JWT)
  return h;
}
async function sb(path, opts = {}) {
  const r = await fetch(SB_URL + '/rest/v1/' + path, { ...opts, headers: sbHeaders(opts.headers) });
  const txt = await r.text();
  let body = null; try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
  return { ok: r.ok, status: r.status, body };
}

// ---------------------------------------------------------------- Graph API
async function graph(method, path, params = {}) {
  const url = new URL(GRAPH + path);
  let init = { method };
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  } else {
    init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    init.body = new URLSearchParams(params).toString();
  }
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    e.meta = j.error; throw e;
  }
  return j;
}

// ---------------------------------------------------------------- Horário
// Converte "2026-10-22" + "19:00" no fuso do usuário para um Date (UTC)
function horarioDoPost(data, hora, fuso) {
  if (!data) return null;
  const [Y, M, D] = data.split('-').map(Number);
  const [h, m] = (hora || '09:00').split(':').map(Number);
  const palpite = Date.UTC(Y, M - 1, D, h, m);
  // descobre o deslocamento do fuso naquele instante
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: fuso, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const partes = Object.fromEntries(fmt.formatToParts(new Date(palpite)).map(p => [p.type, p.value]));
  const comoLocal = Date.UTC(+partes.year, +partes.month - 1, +partes.day, +partes.hour, +partes.minute);
  return new Date(palpite - (comoLocal - palpite));
}

// ---------------------------------------------------------------- Tokens
async function renovarConexoes() {
  const r = await sb('conexoes_meta?select=*');
  if (!r.ok) { log('⚠️ não consegui ler conexoes_meta', r.status, r.body); return new Map(); }
  const mapa = new Map();
  for (const c of r.body || []) {
    try {
      const expirando = c.expira_em && (new Date(c.expira_em) - Date.now()) < 7 * 864e5;
      if (c.user_token && (!c.token_longo || expirando)) {
        const t = await graph('GET', '/oauth/access_token', {
          grant_type: 'fb_exchange_token', client_id: APP_ID, client_secret: APP_SECRET,
          fb_exchange_token: c.user_token });
        const contas = await graph('GET', '/me/accounts', { access_token: t.access_token, limit: '100',
          fields: 'id,name,access_token,instagram_business_account{id,username}' });
        const paginas = (contas.data || []).map(p => ({ id: p.id, name: p.name, token: p.access_token,
          ig_id: p.instagram_business_account && p.instagram_business_account.id,
          ig_user: p.instagram_business_account && p.instagram_business_account.username }));
        const expira = t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null;
        const upd = { user_token: t.access_token, token_longo: true, expira_em: expira, paginas, erro: null, atualizado: new Date().toISOString() };
        if (!SECO) await sb('conexoes_meta?user_id=eq.' + c.user_id, { method: 'PATCH', body: JSON.stringify(upd) });
        Object.assign(c, upd);
        log('🔑 conexão renovada', c.user_id, paginas.map(p => p.name + (p.ig_user ? ' / @' + p.ig_user : '')).join(', '));
      }
    } catch (e) {
      log('⚠️ erro renovando conexão', c.user_id, e.message);
      if (!SECO) await sb('conexoes_meta?user_id=eq.' + c.user_id, { method: 'PATCH',
        body: JSON.stringify({ erro: 'Reconecte o Facebook no Postou: ' + e.message, atualizado: new Date().toISOString() }) }).catch(() => {});
    }
    mapa.set(c.user_id, c);
  }
  return mapa;
}

// ---------------------------------------------------------------- Publicar
function midiasDoPost(p) {
  const lista = Array.isArray(p.midias) && p.midias.length ? p.midias
    : (p.midiaUrl ? [{ url: p.midiaUrl, tipo: p.midiaTipo || 'imagem' }] : []);
  return lista.filter(m => m && m.url);
}
function legendaDe(p, rede) { return (p.legendas && p.legendas[rede]) || p.legenda || ''; }

async function esperarContainer(id, token, maxSeg = 300) {
  for (let s = 0; s < maxSeg; s += 5) {
    const j = await graph('GET', '/' + id, { fields: 'status_code,status', access_token: token });
    if (j.status_code === 'FINISHED') return;
    if (j.status_code === 'ERROR' || j.status_code === 'EXPIRED') throw new Error('Instagram recusou a mídia: ' + (j.status || j.status_code));
    await sleep(5000);
  }
  throw new Error('Instagram demorou demais para processar o vídeo');
}

async function publicarInstagram(p, pagina) {
  if (!pagina.ig_id) throw new Error('Essa página não tem Instagram profissional ligado');
  const tk = pagina.token, ig = '/' + pagina.ig_id;
  const midias = midiasDoPost(p);
  if (!midias.length) throw new Error('O Instagram precisa de foto ou vídeo — suba a arte no post');
  const caption = legendaDe(p, 'instagram');
  let creation;
  if (midias.length === 1) {
    const m = midias[0];
    const params = m.tipo === 'video'
      ? { media_type: 'REELS', video_url: m.url, caption, share_to_feed: 'true', access_token: tk }
      : { image_url: m.url, caption, access_token: tk };
    creation = (await graph('POST', ig + '/media', params)).id;
    await esperarContainer(creation, tk);
  } else {
    const filhos = [];
    for (const m of midias.slice(0, 10)) {
      const params = m.tipo === 'video'
        ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: 'true', access_token: tk }
        : { image_url: m.url, is_carousel_item: 'true', access_token: tk };
      const id = (await graph('POST', ig + '/media', params)).id;
      await esperarContainer(id, tk);
      filhos.push(id);
    }
    creation = (await graph('POST', ig + '/media', { media_type: 'CAROUSEL', children: filhos.join(','), caption, access_token: tk })).id;
    await esperarContainer(creation, tk);
  }
  const pub = await graph('POST', ig + '/media_publish', { creation_id: creation, access_token: tk });
  return { id: pub.id };
}

async function publicarFacebook(p, pagina) {
  const tk = pagina.token, pg = '/' + pagina.id;
  const midias = midiasDoPost(p);
  const message = legendaDe(p, 'facebook');
  if (!midias.length) return { id: (await graph('POST', pg + '/feed', { message, access_token: tk })).id };
  if (midias.length === 1 && midias[0].tipo === 'video')
    return { id: (await graph('POST', pg + '/videos', { file_url: midias[0].url, description: message, access_token: tk })).id };
  if (midias.length === 1)
    return { id: (await graph('POST', pg + '/photos', { url: midias[0].url, message, access_token: tk })).id };
  const fotos = [];
  for (const m of midias.filter(m => m.tipo !== 'video').slice(0, 10))
    fotos.push((await graph('POST', pg + '/photos', { url: m.url, published: 'false', access_token: tk })).id);
  const params = { message, access_token: tk };
  fotos.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  return { id: (await graph('POST', pg + '/feed', params)).id };
}

// ---------------------------------------------------------------- Principal
async function main() {
  if (!SB_URL || !SB_KEY || !APP_ID || !APP_SECRET) {
    console.log('⏸ Robô ainda não configurado (faltam os segredos SUPABASE_URL, SUPABASE_SERVICE_KEY, META_APP_ID, META_APP_SECRET). Nada a fazer.'); return;
  }
  log(SECO ? '🧪 modo seco (não publica)' : '🤖 robô do Postou acordou');
  const conexoes = await renovarConexoes();
  if (!conexoes.size) { log('Ninguém conectou o Facebook ainda.'); return; }

  const ids = [...conexoes.keys()].map(id => '"' + id + '"').join(',');
  const r = await sb(`organizador?select=user_id,conteudo&user_id=in.(${ids})`);
  if (!r.ok) throw new Error('não consegui ler organizador: ' + r.status);

  const ja = await sb(`publicacoes?select=user_id,post_id,rede,status&user_id=in.(${ids})`);
  const feito = new Set((ja.body || []).map(x => `${x.user_id}|${x.post_id}|${x.rede}`));

  const agora = Date.now();
  let total = 0;
  for (const row of r.body || []) {
    const dados = row.conteudo || {};
    const con = conexoes.get(row.user_id);
    const fuso = dados.fuso || FUSO_PADRAO;
    for (const p of dados.posts || []) {
      if (!p.autoPublicar || p.status === 'publicado') continue;
      const quando = horarioDoPost(p.data, p.hora, fuso);
      if (!quando || quando.getTime() > agora || agora - quando.getTime() > JANELA_HORAS * 36e5) continue;
      const cli = (dados.clientes || []).find(c => c.id === p.clienteId) || {};
      for (const rede of (p.redes || []).filter(x => REDES_AUTO.includes(x))) {
        const chave = `${row.user_id}|${p.id}|${rede}`;
        if (feito.has(chave)) continue;
        const pagina = (con.paginas || []).find(pg => pg.id === cli.metaPageId) || null;
        log(`➡️ ${rede} · "${p.titulo}" (${p.data} ${p.hora || ''}) · ${cli.nome || '?'}`);
        if (SECO) { total++; continue; }
        // trava: registra "publicando" antes (unique impede duplicado)
        const trava = await sb('publicacoes', { method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ user_id: row.user_id, post_id: p.id, rede, status: 'publicando' }) });
        if (!trava.ok) { log('   já estava sendo publicado, pulando'); continue; }
        let status = 'ok', resultado;
        try {
          if (!pagina) throw new Error('Escolha a página do Facebook para "' + (cli.nome || 'este perfil') + '" em 🔗 Conexões');
          resultado = rede === 'instagram' ? await publicarInstagram(p, pagina) : await publicarFacebook(p, pagina);
          log('   ✅ publicado', resultado.id);
        } catch (e) {
          status = 'erro'; resultado = { erro: e.message };
          log('   ❌', e.message);
        }
        await sb(`publicacoes?user_id=eq.${row.user_id}&post_id=eq.${p.id}&rede=eq.${rede}`, {
          method: 'PATCH', body: JSON.stringify({ status, resultado }) });
        total++;
      }
    }
  }
  log(`🏁 terminou · ${total} publicação(ões) tratada(s)`);
}

export { horarioDoPost, midiasDoPost, legendaDe, main };
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('💥', e); process.exit(1); });
}
