// =====================================================================
// POSTOU · Robô de RESPOSTAS — responde sozinho comentário simples
// ("linda", "arrasou", "amei", só emoji…) com obrigada + coração.
// Pergunta, crítica ou texto longo NUNCA é respondido sozinho.
// Só nos perfis com "💬 Responder sozinho" ligado no Postou (cliente.autoResponder).
// Precisa da permissão instagram_manage_comments no app do Meta + "Reconectar".
// =====================================================================
const GRAPH = 'https://graph.facebook.com/' + (process.env.META_GRAPH_VERSION || 'v23.0');
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const SECO = process.argv.includes('--seco');
const MAX_POR_RODADA = 25, HORAS = 48;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sbH = () => { const h = { apikey: SB_KEY }; if (SB_KEY.startsWith('eyJ')) h.Authorization = 'Bearer ' + SB_KEY; return h; };
async function sb(p) { const r = await fetch(SB_URL + '/rest/v1/' + p, { headers: sbH() }); return r.ok ? r.json() : []; }
async function graph(method, path, params) {
  const url = new URL(GRAPH + path); let init = { method };
  if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  else { init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; init.body = new URLSearchParams(params).toString(); }
  const r = await fetch(url, init); const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status); return j;
}
const ELOGIOS = ['linda','lindo','lindas','lindos','lindeza','maravilhosa','maravilhoso','maravilha','arrasou','arrasa','arrasando','amei','amo','top','perfeita','perfeito','perfeição','show','incrível','incrivel','demais','diva','musa','gata','gato','que lindo','que linda','parabéns','parabens','sucesso','uau','wow','lacrou','tudo','sensacional','fofa','fofo','fofura','gorgeous','beautiful','love','amazing','nice','cute','bonita','bonito','massa','ameei','ameeei','socorro que lindo'];
const RESPOSTAS = ['Obrigada! 🥰','Obrigadaaa ✨','Ai, que amor! 💕','Obrigada pelo carinho! 🌷','Você é demais! 🙌','Aaah, obrigada! 😍','Fico feliz que gostou! 🌸','Obrigada, flor! 🌻','Que bom que curtiu! 💛','Amei seu comentário! 🧡','Obrigada! Volta sempre 😘','Obrigadaa 💖','Você é um amor! 🤍','Gratidão! 🙏✨','Que fofa(o)! Obrigada 🥹','Obrigada! 💚','❤️🔥 obrigada!','Ahh, obrigada! 🌈'];
function simples(t) {
  const s = String(t || '').toLowerCase().trim();
  if (!s || s.length > 60 || s.includes('?') || /https?:|@\w|\d{3,}/.test(s)) return false;
  const semEmoji = s.replace(/[\p{Extended_Pictographic}\p{Emoji_Component}‍️!.,~*\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!semEmoji) return true; // só emoji
  if (semEmoji.split(' ').length > 6) return false;
  const enx = w => w.replace(/(.)\1+/g, '$1');
  const elog = new Set(ELOGIOS.map(enx));
  const ok = new Set(['que','muito','mto','mt','tão','tao','ficou','fico','você','voce','vc','tá','ta','esta','está','e','a','o','de','meu','minha','deus','amiga','amigo','mais','sempre','vcs','vocês','voces','muitoo']);
  const ws = semEmoji.split(' ').map(enx);
  return ws.some(w => elog.has(w)) && ws.every(w => elog.has(w) || ok.has(w));
}
let ultimaResp = '';
const sorteio = arr => { let r; do { r = arr[Math.floor(Math.random() * arr.length)]; } while (r === ultimaResp && arr.length > 1); ultimaResp = r; return r; };

const conexoes = await sb('conexoes_meta?select=user_id,paginas');
const donos = await sb('organizador?select=user_id,conteudo');
let total = 0;
for (const d of donos) {
  const cont = typeof d.conteudo === 'string' ? JSON.parse(d.conteudo) : (d.conteudo || {});
  const perfis = (cont.clientes || []).filter(c => c.autoResponder && c.metaPageId && !c.arquivado);
  if (!perfis.length) continue;
  const con = conexoes.find(c => c.user_id === d.user_id); if (!con) continue;
  for (const cli of perfis) {
    const pg = (con.paginas || []).find(p => p.id === cli.metaPageId);
    if (!pg || !pg.token || !pg.ig_id) continue;
    try {
      const midias = await graph('GET', '/' + pg.ig_id + '/media', { fields: 'id,timestamp', limit: '12', access_token: pg.token });
      for (const m of midias.data || []) {
        if (Date.now() - new Date(m.timestamp) > 14 * 864e5) continue;
        const cs = await graph('GET', '/' + m.id + '/comments', { fields: 'id,text,username,timestamp,replies{username}', limit: '50', access_token: pg.token });
        for (const c of cs.data || []) {
          if (total >= MAX_POR_RODADA) break;
          if (!c.username || c.username === pg.ig_user) continue;
          if (Date.now() - new Date(c.timestamp) > HORAS * 36e5) continue;
          if ((c.replies && c.replies.data || []).some(r => r.username === pg.ig_user)) continue;
          if (!simples(c.text)) continue;
          const msg = sorteio(RESPOSTAS);
          log(SECO ? '🧪' : '💬', '@' + pg.ig_user, '←', JSON.stringify(c.text), '→', msg);
          if (!SECO) await graph('POST', '/' + c.id + '/replies', { message: msg, access_token: pg.token });
          total++;
        }
      }
    } catch (e) { log('⚠️', cli.nome, e.message); }
  }
}
log('Respondi', total, 'comentário(s).');
