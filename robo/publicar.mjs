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
const REDES_AUTO = ['instagram', 'facebook', 'threads', 'youtube'];
// ▶️ YouTube (Google Cloud projeto "postou-robo", conta jgpazotto@gmail.com)
const YT_CLIENT_ID = process.env.YT_CLIENT_ID || '99506954223-d7ucttpdj5n86bk2d6jlifi7vj79g7d8.apps.googleusercontent.com';
const YT_CLIENT_SECRET = process.env.YT_CLIENT_SECRET || '';
// 🧵 Threads (caso de uso "Acessar a API do Threads" no app Postou)
const GRAPH_TH = 'https://graph.threads.net/v1.0';
const TH_APP_ID = process.env.THREADS_APP_ID || '2093294924680102';
const TH_APP_SECRET = process.env.THREADS_APP_SECRET || '';
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
    if (String(c.code).startsWith('th:')) { await trocarCodigoThreads(c); continue; }
    if (String(c.code).startsWith('yt:')) { if (YT_CLIENT_SECRET) await trocarCodigoYouTube(c); else log('⏸ YouTube esperando o segredo YT_CLIENT_SECRET'); continue; }
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
    // 🧵 Threads: o site só enxerga ig_id, então o id do Threads fica como "th:..."
    if (c.api === 'threads' && !String(c.ig_id).startsWith('th:') && !SECO) {
      c.ig_id = 'th:' + c.ig_id;
      await sb('conexoes_ig?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify({ ig_id: c.ig_id }) });
    }
    // token do Instagram dura 60 dias: renova quando faltar menos de 10
    if (!SECO && c.api === 'threads' && c.expira_em && (new Date(c.expira_em) - Date.now()) < 10 * 864e5) {
      try {
        const t = await graph('GET', 'https://graph.threads.net/refresh_access_token', { grant_type: 'th_refresh_token', access_token: c.token });
        c.token = t.access_token;
        await sb('conexoes_ig?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify({ token: t.access_token, expira_em: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, atualizado: agora }) });
        log('🔑 Threads renovado @' + c.username);
      } catch (e) { log('⚠️ não renovei Threads @' + c.username, e.message); }
    }
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

// ---------------------------------------------------------------- ▶️ YouTube
async function googleToken(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: YT_CLIENT_ID, client_secret: YT_CLIENT_SECRET, ...params }).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Google: ' + (j.error_description || j.error || ('HTTP ' + r.status)));
  return j;
}
async function trocarCodigoYouTube(c) {
  const agora = new Date().toISOString();
  try {
    if (!YT_CLIENT_SECRET) throw new Error('falta o segredo YT_CLIENT_SECRET no GitHub');
    log('▶️ trocando o código do YouTube de', c.user_id);
    const t = await googleToken({ grant_type: 'authorization_code', redirect_uri: REDIRECT_IG, code: String(c.code).slice(3) });
    if (!t.refresh_token) throw new Error('o Google não mandou a chave de longo prazo — conecte de novo');
    const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + t.access_token } });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error('YouTube: ' + (j.error.message || j.error.status || 'erro'));
    const ch = (j.items || [])[0];
    if (!ch) throw new Error('essa conta Google não tem canal no YouTube (ou escolha a conta do canal)');
    await sb(`conexoes_ig?user_id=eq.${c.user_id}&ig_id=eq.yt:${ch.id}&id=neq.${c.id}`, { method: 'DELETE' });
    const linha = { token: t.refresh_token, ig_id: 'yt:' + ch.id, username: (ch.snippet && ch.snippet.title) || ch.id, api: 'youtube', expira_em: null, code: null, erro: null, atualizado: agora };
    await sb('conexoes_ig?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify(linha) });
    Object.assign(c, linha);
    log('   ✅ YouTube ligado: ' + linha.username);
  } catch (e) {
    log('   ❌ YouTube', e.message);
    await sb('conexoes_ig?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify({ code: null, api: 'youtube', erro: 'Conecte o YouTube de novo: ' + e.message, atualizado: agora }) });
    c.code = null; c.erro = e.message; c.api = 'youtube';
  }
}
async function publicarYouTube(p, conta) {
  if (!YT_CLIENT_SECRET) throw new Error('falta o segredo YT_CLIENT_SECRET no GitHub');
  const video = midiasDoPost(p).find(m => m.tipo === 'video' || /\.(mp4|mov)(\?|$)/i.test(m.url));
  if (!video) throw new Error('YouTube só aceita vídeo — esse post não tem vídeo');
  const { access_token } = await googleToken({ grant_type: 'refresh_token', refresh_token: conta.token });
  const v = await fetch(video.url);
  if (!v.ok) throw new Error('não consegui baixar o vídeo (' + v.status + ')');
  const bytes = Buffer.from(await v.arrayBuffer());
  const leg = legendaDe(p, 'youtube');
  let titulo = (p.tituloYT || p.titulo || leg.split('\n')[0] || 'Vídeo').replace(/[<>]/g, '').trim();
  if (titulo.length > 90) titulo = titulo.slice(0, 89) + '…';
  if (!/#shorts/i.test(titulo)) titulo += ' #Shorts';
  const meta = { snippet: { title: titulo, description: leg.replace(/[<>]/g, '').slice(0, 4900), categoryId: '22' },
    status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } };
  const ini = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', { method: 'POST',
    headers: { Authorization: 'Bearer ' + access_token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/*', 'X-Upload-Content-Length': String(bytes.length) },
    body: JSON.stringify(meta) });
  if (!ini.ok) { const e = await ini.json().catch(() => ({})); throw new Error('YouTube: ' + ((e.error && e.error.message) || ('HTTP ' + ini.status))); }
  const up = await fetch(ini.headers.get('location'), { method: 'PUT', headers: { 'Content-Type': 'video/*' }, body: bytes });
  const j = await up.json().catch(() => ({}));
  if (!up.ok || !j.id) throw new Error('YouTube: ' + ((j.error && j.error.message) || ('HTTP ' + up.status)));
  const privado = j.status && j.status.privacyStatus !== 'public';
  return { id: j.id, link: 'https://youtube.com/shorts/' + j.id, ...(privado ? { aviso: 'saiu privado (app em verificação no Google)' } : {}) };
}

// ---------------------------------------------------------------- 🪞 Espelho
// Tudo que sair no Instagram de um perfil (mesmo postado pelo app do Instagram / Edits)
// vai sozinho pros stories dos perfis escolhidos em cliente.espelhoPara (desde cliente.espelhoDesde).
function contaDoPerfil(cli, con, igs) {
  const pg = (con.paginas || []).find(p => p.id === cli.metaPageId && p.ig_id);
  if (pg) return { ig_id: pg.ig_id, token: pg.token, base: '' };
  const a = cli.igConta ? igs.find(x => x.api !== 'threads' && x.api !== 'youtube' && x.ig_id === cli.igConta) : null;
  if (a) return { ig_id: a.ig_id, token: a.token, base: a.api === 'ig' ? GRAPH_IG : '' };
  return null;
}
async function espelhar(row, dados, con, igs, feito, doRobo) {
  let n = 0;
  const clientes = dados.clientes || [];
  for (const cli of clientes) {
    const alvos = (Array.isArray(cli.espelhoPara) ? cli.espelhoPara : []).map(String).filter(x => x !== String(cli.id));
    if (!alvos.length || !cli.espelhoDesde) continue;
    const fonte = contaDoPerfil(cli, con, igs);
    if (!fonte) continue;
    const B = fonte.base || GRAPH;
    const desde = Math.max(new Date(cli.espelhoDesde).getTime() || 0, Date.now() - 24 * 36e5);
    let itens = [];
    try {
      const m = await graph('GET', B + '/' + fonte.ig_id + '/media', { fields: 'id,media_type,media_url,thumbnail_url,timestamp,caption', limit: 6, access_token: fonte.token });
      itens = itens.concat((m.data || []).map(x => ({ ...x, deStory: false })));
    } catch (e) { log('⚠️ espelho: não li os posts de', cli.nome, e.message); }
    try {
      const st = await graph('GET', B + '/' + fonte.ig_id + '/stories', { fields: 'id,media_type,media_url,timestamp', access_token: fonte.token });
      itens = itens.concat((st.data || []).map(x => ({ ...x, deStory: true })));
    } catch (e) { log('⚠️ espelho: não li os stories de', cli.nome, '—', e.message); }
    log(`🪞 espelho: ${cli.nome} — ${itens.filter(x => !x.deStory).length} post(s) e ${itens.filter(x => x.deStory).length} story(s) lidos`);
    for (const x of itens.filter(x => x.deStory)) {
      const t = new Date(x.timestamp).getTime();
      log(`   🔎 story ${x.id} de ${x.timestamp} · tipo ${x.media_type} · ${x.media_url ? 'tem link' : 'SEM link (música/figurinha?)'} · ${t >= desde ? 'dentro do prazo' : 'antes do espelho ligar'} · ${doRobo.has(String(x.id)) ? 'foi o robô que postou' : 'postado pela pessoa'}`);
    }
    itens = itens.filter(x => x.id && x.timestamp && new Date(x.timestamp).getTime() >= desde && !doRobo.has(String(x.id)))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    for (const it of itens) {
      // 🚫 perfil pessoal não leva propaganda: post que fala do Postou não é espelhado
      if (/postou/i.test(it.caption || '')) { log(`   ⏭ espelho: post de ${cli.nome} fala do Postou — não vai pro story dos outros`); continue; }
      let url = it.media_url, tipo = it.media_type === 'VIDEO' ? 'video' : 'imagem';
      if (it.media_type === 'CAROUSEL_ALBUM') {
        try {
          const ch = await graph('GET', B + '/' + it.id + '/children', { fields: 'media_type,media_url', access_token: fonte.token });
          const f = (ch.data || [])[0]; if (f) { url = f.media_url; tipo = f.media_type === 'VIDEO' ? 'video' : 'imagem'; }
        } catch (e) { /* usa o que veio */ }
      }
      if (!url) { log(`   ⏭ espelho: ${it.deStory ? 'story' : 'post'} ${it.id} de ${cli.nome} veio sem link da mídia (o Instagram não entrega quando tem música/figurinha) — fica manual`); continue; }
      for (const cid of alvos) {
        const rede = 'espelho:' + cid;
        if (feito.has(`${row.user_id}|${it.id}|${rede}`)) continue;
        const alvoCli = clientes.find(c => String(c.id) === cid);
        const alvo = alvoCli && contaDoPerfil(alvoCli, con, igs);
        if (!alvo || alvo.ig_id === fonte.ig_id) continue;
        if (n >= 6) return n; // no máximo 6 por rodada
        log(`🪞 espelho: ${cli.nome} → story de ${alvoCli.nome} (${it.deStory ? 'story' : it.media_type})`);
        if (SECO) { n++; continue; }
        const trava = await sb('publicacoes', { method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ user_id: row.user_id, post_id: String(it.id), rede, status: 'publicando' }) });
        feito.add(`${row.user_id}|${it.id}|${rede}`);
        if (!trava.ok) { log('   já feito/trava:', trava.status); continue; }
        let status = 'ok', resultado;
        try {
          resultado = await publicarInstagram({ tipo: 'story', midias: [{ url, tipo }] }, alvo);
          resultado.de = cli.nome;
          log('   ✅ espelhado', resultado.id); if (resultado.id) doRobo.add(String(resultado.id));
        } catch (e) { status = 'erro'; resultado = { erro: e.message, de: cli.nome }; log('   ❌', e.message); }
        await sb(`publicacoes?user_id=eq.${row.user_id}&post_id=eq.${it.id}&rede=eq.${encodeURIComponent(rede)}`, {
          method: 'PATCH', body: JSON.stringify({ status, resultado }) });
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- 🧵 Threads
async function trocarCodigoThreads(c) {
  const agora = new Date().toISOString();
  try {
    if (!TH_APP_SECRET) throw new Error('falta o segredo THREADS_APP_SECRET no GitHub');
    log('🧵 trocando o código do Threads de', c.user_id);
    const curto = await graph('POST', 'https://graph.threads.net/oauth/access_token', { client_id: TH_APP_ID, client_secret: TH_APP_SECRET, grant_type: 'authorization_code', redirect_uri: REDIRECT_IG, code: String(c.code).slice(3) });
    const t = await graph('GET', 'https://graph.threads.net/access_token', { grant_type: 'th_exchange_token', client_secret: TH_APP_SECRET, access_token: curto.access_token });
    const me = await graph('GET', GRAPH_TH + '/me', { fields: 'id,username', access_token: t.access_token });
    await sb(`conexoes_ig?user_id=eq.${c.user_id}&ig_id=eq.th:${me.id}&id=neq.${c.id}`, { method: 'DELETE' });
    const linha = { token: t.access_token, ig_id: 'th:' + me.id, username: me.username || null, api: 'threads',
      expira_em: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, code: null, erro: null, atualizado: agora };
    await sb('conexoes_ig?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify(linha) });
    Object.assign(c, linha);
    log('   ✅ Threads ligado @' + me.username);
  } catch (e) {
    log('   ❌ Threads', e.message);
    await sb('conexoes_ig?id=eq.' + c.id, { method: 'PATCH', body: JSON.stringify({ code: null, api: 'threads', erro: 'Conecte o Threads de novo: ' + e.message, atualizado: agora }) });
    c.code = null; c.erro = e.message; c.api = 'threads';
  }
}
async function publicarThreads(p, conta) {
  const tk = conta.token, base = GRAPH_TH + '/' + String(conta.ig_id).replace(/^th:/, '');
  const texto = legendaDe(p, 'threads').slice(0, 500);
  const midias = midiasDoPost(p);
  const ehVideo = m => m.tipo === 'video' || /\.(mp4|mov)(\?|$)/i.test(m.url);
  let criacao;
  if (!midias.length) {
    criacao = await graph('POST', base + '/threads', { media_type: 'TEXT', text: texto, access_token: tk });
  } else if (midias.length === 1) {
    const m = midias[0];
    criacao = await graph('POST', base + '/threads', ehVideo(m)
      ? { media_type: 'VIDEO', video_url: m.url, text: texto, access_token: tk }
      : { media_type: 'IMAGE', image_url: m.url, text: texto, access_token: tk });
  } else {
    const filhos = [];
    for (const m of midias.slice(0, 20)) {
      const f = await graph('POST', base + '/threads', ehVideo(m)
        ? { media_type: 'VIDEO', video_url: m.url, is_carousel_item: 'true', access_token: tk }
        : { media_type: 'IMAGE', image_url: m.url, is_carousel_item: 'true', access_token: tk });
      filhos.push(f.id);
    }
    await esperarThreads(filhos[filhos.length - 1], tk);
    criacao = await graph('POST', base + '/threads', { media_type: 'CAROUSEL', children: filhos.join(','), text: texto, access_token: tk });
  }
  await esperarThreads(criacao.id, tk);
  return { id: (await graph('POST', base + '/threads_publish', { creation_id: criacao.id, access_token: tk })).id };
}
async function esperarThreads(id, tk, maxSeg = 300) {
  // a Meta recomenda esperar ~30s; conferimos o status até ficar pronto
  for (let s = 0; s < maxSeg; s += 10) {
    await sleep(s === 0 ? 5000 : 10000);
    try {
      const j = await graph('GET', GRAPH_TH + '/' + id, { fields: 'status,error_message', access_token: tk });
      if (j.status === 'FINISHED' || j.status === 'PUBLISHED') return;
      if (j.status === 'ERROR' || j.status === 'EXPIRED') throw new Error('Threads recusou a mídia: ' + (j.error_message || j.status));
    } catch (e) { if (/recusou/.test(e.message)) throw e; if (s > 60) return; }
  }
}

// ---------------------------------------------------------------- Publicar
function midiasDoPost(p) {
  const lista = Array.isArray(p.midias) && p.midias.length ? p.midias
    : (p.midiaUrl ? [{ url: p.midiaUrl, tipo: p.midiaTipo || 'imagem' }] : []);
  return lista.filter(m => m && m.url);
}
// 📱 story: usa a versão em pé (9:16) que o site montou, se for da mesma arte
function midiaDoStory(p) {
  const m = midiasDoPost(p).slice(0, 1);
  if (m.length && p.midiaStory && p.midiaStory.url && p.midiaStory.de === m[0].url) return [{ url: p.midiaStory.url, tipo: 'imagem' }];
  return m;
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

// ⏳ o Instagram às vezes diz "Media ID is not available" logo depois de montar: espera e tenta de novo
async function publicarContainer(ig, creation, tk) {
  for (let t = 0; ; t++) {
    try { return await graph('POST', ig + '/media_publish', { creation_id: creation, access_token: tk }); }
    catch (e) {
      if (t >= 3 || !/not available|not ready|try again/i.test(e.message)) throw e;
      log(`   ⏳ Instagram ainda processando (${e.message}) — tento de novo em ${10 * (t + 1)}s`);
      await new Promise(r => setTimeout(r, 10000 * (t + 1)));
    }
  }
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
      ultimo = (await publicarContainer(ig, id, tk)).id;
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
  const pub = await publicarContainer(ig, creation, tk);
  return { id: pub.id };
}

// 🔗 link do post publicado (se a API não der, segue sem link — não atrapalha)
async function pegarLink(path, campo, tk) {
  try { return (await graph('GET', path, { fields: campo, access_token: tk }))[campo] || null; } catch { return null; }
}

// 🎬 Story em VÍDEO na Página do Facebook (3 passos: start → upload por link → finish)
async function storyVideoFacebook(pg, tk, url) {
  const ini = await graph('POST', pg + '/video_stories', { upload_phase: 'start', access_token: tk });
  if (!ini.video_id) throw new Error('Facebook não abriu o envio do story em vídeo');
  const ver = process.env.META_GRAPH_VERSION || 'v23.0';
  const up = await fetch(ini.upload_url || ('https://rupload.facebook.com/video-upload/' + ver + '/' + ini.video_id), {
    method: 'POST', headers: { Authorization: 'OAuth ' + tk, file_url: url } });
  const uj = await up.json().catch(() => ({}));
  if (!up.ok || uj.error || uj.success === false)
    throw new Error('Facebook recusou o vídeo do story: ' + ((uj.error && (uj.error.message || uj.error.error_user_msg)) || ('HTTP ' + up.status)));
  const fim = await graph('POST', pg + '/video_stories', { upload_phase: 'finish', video_id: ini.video_id, access_token: tk });
  return fim.post_id || ini.video_id;
}

async function publicarFacebook(p, pagina) {
  const tk = pagina.token, pg = '/' + pagina.id;
  const midias = midiasDoPost(p);
  const message = legendaDe(p, 'facebook');
  // 📱 Story na Página: foto e vídeo (vídeo em pé, 3 a 60s)
  if (p.tipo === 'story') {
    if (!midias.length) throw new Error('Story precisa de foto ou vídeo');
    let ultimo = null;
    for (const m of midias.slice(0, 10)) {
      if (m.tipo === 'video') { ultimo = await storyVideoFacebook(pg, tk, m.url); continue; }
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


// ---------------------------------------------------------------- 🎬 Reels feitos no Postou
// O "✨ Fotos → Reels" grava no navegador; alguns aparelhos geram WebM/VP9. O Instagram só aceita
// MP4 (H.264 + AAC) → aqui o robô confere e, se precisar, converte com o ffmpeg do GitHub.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function prepararVideos(p, userId) {
  if (!Array.isArray(p.midias)) return;
  for (const m of p.midias) {
    if (!m || m.tipo !== 'video' || !/^postou-reels-/.test(m.nome || '')) continue;
    const pasta = mkdtempSync(join(tmpdir(), 'reel-')), ent = join(pasta, 'entrada'), sai = join(pasta, 'saida.mp4');
    const r = await fetch(m.url); if (!r.ok) throw new Error('não baixei o vídeo (' + r.status + ')');
    writeFileSync(ent, Buffer.from(await r.arrayBuffer()));
    try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); }
    catch { log('   📦 instalando o ffmpeg (só quando precisa)…'); execFileSync('bash', ['-c', 'sudo apt-get update -qq && sudo apt-get install -y -qq ffmpeg'], { stdio: 'ignore' }); }
    const codecs = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', ent]).toString();
    if (/h264/.test(codecs) && !/opus|vorbis/.test(codecs) && /\.mp4(\?|$)/i.test(m.url)) continue;
    log('   🎬 convertendo o Reels do Postou pra MP4 (' + codecs.replace(/\s+/g, ' ').trim() + ')');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', ent, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-movflags', '+faststart', sai]);
    const caminho = userId + '/reels-ig-' + Date.now() + '.mp4';
    const up = await fetch(SB_URL + '/storage/v1/object/midias/' + caminho, { method: 'POST',
      headers: { ...sbHeaders({ 'Content-Type': 'video/mp4', 'x-upsert': 'true' }) }, body: readFileSync(sai) });
    if (!up.ok) throw new Error('não consegui guardar o MP4 (' + up.status + ' ' + (await up.text()).slice(0, 120) + ')');
    m.url = SB_URL + '/storage/v1/object/public/midias/' + caminho;
    log('   ✅ MP4 pronto');
  }
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

  const ja = await sb(`publicacoes?select=user_id,post_id,rede,status,resultado&user_id=in.(${ids})`);
  const feito = new Set((ja.body || []).map(x => `${x.user_id}|${x.post_id}|${x.rede}`));
  // ids que o próprio robô publicou (o 🪞 espelho não repete o que já saiu pelo Postou)
  const doRobo = new Set((ja.body || []).map(x => x.resultado && x.resultado.id).filter(Boolean).map(String));

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
      // 📱 "post vira story": depois do Instagram, publica a 1ª foto/vídeo também como story
      const redesDoPost = (p.redes || []).filter(x => REDES_AUTO.includes(x));
      if (p.virarStory && p.tipo !== 'story' && redesDoPost.includes('instagram')) redesDoPost.push('instagram_story');
      // 📲 "story também em outro perfil": repete a arte nos stories de outros perfis (ex.: @jgpazotto)
      for (const cid of (Array.isArray(p.storyEm) ? p.storyEm : [])) if (String(cid) !== String(p.clienteId)) redesDoPost.push('story:' + cid);
      for (const rede of redesDoPost) {
        const chave = `${row.user_id}|${p.id}|${rede}`;
        if (feito.has(chave)) continue;
        const storyOutro = rede.startsWith('story:');
        const cliR = storyOutro ? (dados.clientes || []).find(c => String(c.id) === rede.slice(6)) : cli;
        if (!cliR) continue; // perfil do story extra foi apagado
        const contaTH = rede === 'threads' ? igsDoUsuario.find(a => a.api === 'threads' && a.ig_id === cliR.thConta) : null;
        if (rede === 'threads' && !contaTH) { continue; } // perfil sem Threads ligado: fica manual
        const contaYT = rede === 'youtube' ? igsDoUsuario.find(a => a.api === 'youtube' && a.ig_id === cliR.ytConta) : null;
        if (rede === 'youtube' && !contaYT) { continue; } // perfil sem YouTube ligado: fica manual
        const pagina = (con.paginas || []).find(pg => pg.id === cliR.metaPageId) || null;
        const contaIG = !pagina && cliR.igConta ? igsDoUsuario.find(a => a.api !== 'threads' && a.api !== 'youtube' && a.ig_id === cliR.igConta) : null;
        if (!contaYT && storyOutro && !pagina && !contaIG) { log(`   ⏭ ${cliR.nome}: sem Instagram ligado — story extra fica manual`); continue; }
        if (!pagina && contaIG && rede === 'facebook') { log(`   ⏭ ${cliR.nome}: só Instagram (sem Página) — Facebook fica manual`); continue; }
        log(`➡️ ${rede} · "${p.titulo}" (${p.data} ${p.hora || ''}) · ${cliR.nome || '?'}`);
        if (SECO) { total++; continue; }
        if (!p._videosProntos) { p._videosProntos = true; try { await prepararVideos(p, row.user_id); } catch (e) { log('   ⚠️ não consegui converter o vídeo:', e.message); } }
        // trava: registra "publicando" antes (unique impede duplicado)
        const trava = await sb('publicacoes', { method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ user_id: row.user_id, post_id: p.id, rede, status: 'publicando' }) });
        if (!trava.ok) { log('   já estava sendo publicado, pulando'); continue; }
        let status = 'ok', resultado;
        try {
          const ehStoryIG = rede === 'instagram_story' || storyOutro || (p.tipo === 'story' && rede === 'instagram');
          const pp = ehStoryIG ? { ...p, tipo: 'story', midias: midiaDoStory(p) } : p;
          if (contaYT) {
            resultado = await publicarYouTube(p, contaYT);
          } else if (contaTH) {
            resultado = await publicarThreads(pp, contaTH);
            resultado.link = await pegarLink(GRAPH_TH + '/' + resultado.id, 'permalink', contaTH.token);
          } else if (contaIG) {
            const B = contaIG.api === 'ig' ? GRAPH_IG : GRAPH;
            resultado = await publicarInstagram(pp, { ig_id: contaIG.ig_id, token: contaIG.token, base: contaIG.api === 'ig' ? GRAPH_IG : '' });
            if (!resultado.story) resultado.link = await pegarLink(B + '/' + resultado.id, 'permalink', contaIG.token);
          } else {
            if (!pagina) throw new Error('Escolha a página do Facebook para "' + (cliR.nome || 'este perfil') + '" em 🔗 Conexões');
            resultado = rede === 'facebook' ? await publicarFacebook(pp, pagina) : await publicarInstagram(pp, pagina);
            if (!resultado.story) resultado.link = rede === 'facebook'
              ? (await pegarLink(GRAPH + '/' + resultado.id, 'permalink_url', pagina.token)) || ('https://www.facebook.com/' + resultado.id)
              : await pegarLink(GRAPH + '/' + resultado.id, 'permalink', pagina.token);
          }
          log('   ✅ publicado', resultado.id);
        } catch (e) {
          status = 'erro'; resultado = { erro: e.message };
          log('   ❌', e.message);
        }
        if (resultado && resultado.id) doRobo.add(String(resultado.id)); // espelho não repete o que o robô acabou de postar
        await sb(`publicacoes?user_id=eq.${row.user_id}&post_id=eq.${p.id}&rede=eq.${rede}`, {
          method: 'PATCH', body: JSON.stringify({ status, resultado }) });
        total++;
      }
    }
    try { total += await espelhar(row, dados, con, igsDoUsuario, feito, doRobo); } catch (e) { log('⚠️ espelho', e.message); }
  }
  log(`🏁 terminou · ${total} publicação(ões) tratada(s)`);
}

export { horarioDoPost, midiasDoPost, legendaDe, main };
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('💥', e); process.exit(1); });
}
