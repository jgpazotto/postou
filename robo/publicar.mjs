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
const GRAPH_IG = 'https://graph.instagram.com/' + (process.env.META_GRAPH_VERSION || 'v23.0');
const REDIRECT_IG = 'https://postou.app.br/';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const APP_ID = process.env.META_APP_ID || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const IG_APP_ID = process.env.IG_APP_ID || '1039348538855189';
const IG_APP_SECRET = process.env.IG_APP_SECRET || '';  // "Chave secreta do app do Instagram" (Meta → Instagram → Login da empresa)
const JANELA_HORAS = 12;           // publica posts cujo horário passou há no máximo 12h (o GitHub às vezes atrasa o agendamento)
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
  const url = new URL(path.startsWith('http') ? path : GRAPH + path);
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

// ---------------------------------------------------------------- 📸 Login do Instagram (sem Página)
async function descobrirContasIG(token) {
  const contas = [];
  // 1) token do Instagram (graph.instagram.com)
  try {
    const me = await graph('GET', GRAPH_IG + '/me', { fields: 'user_id,username', access_token: token });
    if (me.user_id || me.id) contas.push({ ig_id: String(me.user_id || me.id), username: me.username || null, api: 'ig' });
  } catch (e) { log('   (graph.instagram.com/me não aceitou:', e.message + ')'); }
  if (contas.length) return contas;
  // 2) token do Facebook para Empresas: as contas liberadas aparecem no debug_token
  const dbg = await graph('GET', '/debug_token', { input_token: token, access_token: APP_ID + '|' + APP_SECRET });
  const ids = new Set();
  for (const g of (dbg.data && dbg.data.granular_scopes) || [])
    if (/instagram/.test(g.scope)) (g.target_ids || []).forEach(id => ids.add(String(id)));
  for (const id of ids) {
    try {
      const j = await graph('GET', '/' + id, { fields: 'id,username', access_token: token });
      if (j.username) contas.push({ ig_id: id, username: j.username, api: 'fb' });
    } catch (e) { log('   conta', id, 'não abriu:', e.message); }
  }
  // 3) último recurso: Instagram ligado a páginas
  if (!contas.length) {
    try {
      const pg = await graph('GET', '/me/accounts', { access_token: token, fields: 'instagram_business_account{id,username}', limit: '100' });
      for (const p of pg.data || []) if (p.instagram_business_account)
        contas.push({ ig_id: p.instagram_business_account.id, username: p.instagram_business_account.username, api: 'fb' });
    } catch (e) {}
  }
  if (!contas.length) throw new Error('Não encontrei nenhuma conta do Instagram liberada nesse login. Conecte de novo e marque a conta.');
  return contas;
}
async function conexoesInstagram() {
  const r = await sb('conexoes_ig?select=*');
  if (!r.ok) { log('⚠️ não consegui ler conexoes_ig', r.status, r.body); return new Map(); }
  const agora = new Date().toISOString();
  for (const c of r.body || []) {
    if (!c.code || SECO) continue;
    try {
      log('📸 trocando o código do Instagram de', c.user_id);
      let t;
      if (IG_APP_SECRET) {
        // Login do Instagram (instagram.com/oauth/authorize): troca no api.instagram.com e pega a chave de 60 dias
        const curto = await graph('POST', 'https://api.instagram.com/oauth/access_token', { client_id: IG_APP_ID, client_secret: IG_APP_SECRET, grant_type: 'authorization_code', redirect_uri: REDIRECT_IG, code: c.code });
        t = await graph('GET', GRAPH_IG.replace(/\/v[\d.]+$/, '') + '/access_token', { grant_type: 'ig_exchange_token', client_secret: IG_APP_SECRET, access_token: curto.access_token });
      } else {
        t = await graph('GET', '/oauth/access_token', { client_id: APP_ID, client_secret: APP_SECRET, redirect_uri: REDIRECT_IG, code: c.code });
      }
      const contas = await descobrirContasIG(t.access_token);
      const expira = t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null;
      for (const [i, a] of contas.entries()) {
        // tira conexão antiga da mesma conta
        await sb(`conexoes_ig?user_id=eq.${c.user_id}&ig_id=eq.${a.ig_id}&id=neq.${c.id}`, { method: 'DELETE' });
        const linha = { token: t.access_token, ig_id: a.ig_id, username: a.username, api: a.api, expira_em: expira, code: null, erro: null, atualizado: agora };
        if (i === 0) { await sb('conexoes_ig?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify(linha) }); Object.assign(c, linha); }
        else { await sb('conexoes_ig', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...linha, user_id: c.user_id }) }); r.body.push({ ...linha, user_id: c.user_id }); }
        log('   ✅ ligado @' + a.username + ' (' + a.api + ')');
      }
    } catch (e) {
      log('   ❌', e.message);
      await sb('conexoes_ig?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify({ code: null, erro: 'Conecte de novo: ' + e.message, atualizado: agora }) });
      c.code = null; c.erro = e.message;
    }
  }
  const mapa = new Map();
  for (const c of r.body || []) {
    if (!c.token || !c.ig_id) continue;
    // token do Instagram dura 60 dias: renova quando faltar menos de 10
    if (!SECO && c.api === 'ig' && c.expira_em && (new Date(c.expira_em) - Date.now()) < 10 * 864e5) {
      try {
        const t = await graph('GET', GRAPH_IG.replace(/\/v[\d.]+$/, '') + '/refresh_access_token', { grant_type: 'ig_refresh_token', access_token: c.token });
        c.token = t.access_token;
        const upd = { token: t.access_token, expira_em: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, atualizado: agora };
        await sb('conexoes_ig?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify(upd) });
        log('🔑 Instagram renovado @' + c.username);
      } catch (e) { log('⚠️ não renovei @' + c.username, e.message); }
    }
    if (!mapa.has(c.user_id)) mapa.set(c.user_id, []);
    mapa.get(c.user_id).push(c);
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

async function esperarContainer(id, token, maxSeg = 300, base = '') {
  for (let s = 0; s < maxSeg; s += 5) {
    const j = await graph('GET', base + '/' + id, { fields: 'status_code,status', access_token: token });
    if (j.status_code === 'FINISHED') return;
    if (j.status_code === 'ERROR' || j.status_code === 'EXPIRED') throw new Error('Instagram recusou a mídia: ' + (j.status || j.status_code));
    await sleep(5000);
  }
  throw new Error('Instagram demorou demais para processar o vídeo');
}

async function publicarInstagram(p, pagina) {
  if (!pagina.ig_id) throw new Error('Essa página não tem Instagram profissional ligado');
  const tk = pagina.token, B = pagina.base || '', ig = B + '/' + pagina.ig_id;
  const midias = midiasDoPost(p);
  if (!midias.length) throw new Error('O Instagram precisa de foto ou vídeo — suba a arte no post');
  // 📱 Story: cada foto/vídeo vira um story (a API não põe enquete, música, link nem figurinha)
  if (p.tipo === 'story') {
    let ultimo = null;
    for (const m of midias.slice(0, 10)) {
      const params = m.tipo === 'video'
        ? { media_type: 'STORIES', video_url: m.url, access_token: tk }
        : { media_type: 'STORIES', image_url: m.url, access_token: tk };
      const id = (await graph('POST', ig + '/media', params)).id;
      await esperarContainer(id, tk, 300, B);
      ultimo = (await graph('POST', ig + '/media_publish', { creation_id: id, access_token: tk })).id;
    }
    return { id: ultimo, story: true };
  }
  const caption = legendaDe(p, 'instagram');
  // collab: convida até 3 perfis (eles aceitam no Instagram deles)
  const collab = Array.isArray(p.collabIG) ? p.collabIG.filter(Boolean).slice(0, 3) : [];
  const comCollab = (params) => collab.length ? { ...params, collaborators: JSON.stringify(collab) } : params;
  // se o Instagram recusar o convite de collab, publica sem collab (não perde o post)
  const criarComCollab = async (params) => {
    if (!collab.length) return graph('POST', ig + '/media', params);
    try { return await graph('POST', ig + '/media', comCollab(params)); }
    catch (e) { log('   ⚠️ collab recusado (' + e.message + ') — publicando sem collab'); return graph('POST', ig + '/media', params); }
  };
  let creation;
  if (midias.length === 1) {
    const m = midias[0];
    const params = m.tipo === 'video'
      ? { media_type: 'REELS', video_url: m.url, caption, share_to_feed: 'true', access_token: tk }
      : { image_url: m.url, caption, access_token: tk };
    creation = (await criarComCollab(params)).id;
    await esperarContainer(creation, tk, 300, B);
  } else {
    const filhos = [];
    for (const m of midias.slice(0, 10)) {
      const params = m.tipo === 'video'
        ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: 'true', access_token: tk }
        : { image_url: m.url, is_carousel_item: 'true', access_token: tk };
      const id = (await graph('POST', ig + '/media', params)).id;
      await esperarContainer(id, tk, 300, B);
      filhos.push(id);
    }
    creation = (await criarComCollab({ media_type: 'CAROUSEL', children: filhos.join(','), caption, access_token: tk })).id;
    await esperarContainer(creation, tk, 300, B);
  }
  const pub = await graph('POST', ig + '/media_publish', { creation_id: creation, access_token: tk });
  return { id: pub.id };
}

async function publicarFacebook(p, pagina) {
  const tk = pagina.token, pg = '/' + pagina.id;
  const midias = midiasDoPost(p);
  const message = legendaDe(p, 'facebook');
  // 📱 Story na Página: só foto (story em vídeo no Facebook fica manual por enquanto)
  if (p.tipo === 'story') {
    if (!midias.length) throw new Error('Story precisa de foto ou vídeo');
    let ultimo = null;
    for (const m of midias.slice(0, 10)) {
      if (m.tipo === 'video') throw new Error('Story em vídeo no Facebook ainda é manual — no Instagram foi');
      const foto = await graph('POST', pg + '/photos', { url: m.url, published: 'false', access_token: tk });
      ultimo = (await graph('POST', pg + '/photo_stories', { photo_id: foto.id, access_token: tk })).post_id || foto.id;
    }
    return { id: ultimo, story: true };
  }
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
  const contasIG = await conexoesInstagram();
  if (!conexoes.size && !contasIG.size) { log('Ninguém conectou o Facebook/Instagram ainda.'); return; }

  const ids = [...new Set([...conexoes.keys(), ...contasIG.keys()])].map(id => '"' + id + '"').join(',');
  const r = await sb(`organizador?select=user_id,conteudo&user_id=in.(${ids})`);
  if (!r.ok) throw new Error('não consegui ler organizador: ' + r.status);

  const ja = await sb(`publicacoes?select=user_id,post_id,rede,status&user_id=in.(${ids})`);
  const feito = new Set((ja.body || []).map(x => `${x.user_id}|${x.post_id}|${x.rede}`));

  const agora = Date.now();
  let total = 0;
  for (const row of r.body || []) {
    const dados = row.conteudo || {};
    const con = conexoes.get(row.user_id) || { paginas: [] };
    const igsDoUsuario = contasIG.get(row.user_id) || [];
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
        const contaIG = !pagina && cli.igConta ? igsDoUsuario.find(a => a.ig_id === cli.igConta) : null;
        if (!pagina && contaIG && rede === 'facebook') { log(`   ⏭ ${cli.nome}: só Instagram (sem Página) — Facebook fica manual`); continue; }
        log(`➡️ ${rede} · "${p.titulo}" (${p.data} ${p.hora || ''}) · ${cli.nome || '?'}`);
        if (SECO) { total++; continue; }
        // trava: registra "publicando" antes (unique impede duplicado)
        const trava = await sb('publicacoes', { method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ user_id: row.user_id, post_id: p.id, rede, status: 'publicando' }) });
        if (!trava.ok) { log('   já estava sendo publicado, pulando'); continue; }
        let status = 'ok', resultado;
        try {
          if (contaIG) resultado = await publicarInstagram(p, { ig_id: contaIG.ig_id, token: contaIG.token, base: contaIG.api === 'ig' ? GRAPH_IG : '' });
          else {
            if (!pagina) throw new Error('Escolha a página do Facebook para "' + (cli.nome || 'este perfil') + '" em 🔗 Conexões');
            resultado = rede === 'instagram' ? await publicarInstagram(p, pagina) : await publicarFacebook(p, pagina);
          }
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
