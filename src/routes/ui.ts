import type { FastifyInstance } from 'fastify';

/**
 * Painel de operacao servido pelo proprio HUB em /ui.
 *
 * Sem build, sem dependencia externa: uma pagina so, embutida como string para
 * que o `tsc` nao precise copiar assets. A rota fica FORA do hook de admin —
 * o HTML nao contem segredo, e o token e digitado pelo operador e guardado
 * apenas no sessionStorage do navegador.
 */

const PAGINA = String.raw`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>HUB WuzAPI - Chatwoot</title>
<style>
:root{
  --bg:#f6f7f9; --card:#fff; --tx:#1a1d21; --tx2:#5b6472; --bd:#e3e6ea;
  --ac:#2563eb; --ok:#15803d; --okbg:#dcfce7; --er:#b91c1c; --erbg:#fee2e2;
  --wa:#a16207; --wabg:#fef3c7; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#0f1115;--card:#171a20;--tx:#e6e8eb;--tx2:#98a1ae;--bd:#272c34;
    --ac:#60a5fa;--ok:#4ade80;--okbg:#14301f;--er:#f87171;--erbg:#3a1717;--wa:#fbbf24;--wabg:#332611;}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{background:var(--card);border-bottom:1px solid var(--bd);padding:14px 20px;
  display:flex;gap:14px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:10}
header h1{font-size:16px;margin:0;font-weight:650}
header .sp{flex:1}
main{max-width:1100px;margin:0 auto;padding:20px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:18px;margin-bottom:16px}
.card h2{margin:0 0 14px;font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--tx2)}
button{font:inherit;padding:7px 13px;border-radius:7px;border:1px solid var(--bd);
  background:var(--card);color:var(--tx);cursor:pointer}
button:hover:not(:disabled){border-color:var(--ac);color:var(--ac)}
button:disabled{opacity:.5;cursor:not-allowed}
button.pri{background:var(--ac);border-color:var(--ac);color:#fff}
button.pri:hover:not(:disabled){opacity:.9;color:#fff}
input[type=text],input[type=password],select{font:inherit;padding:7px 10px;border-radius:7px;
  border:1px solid var(--bd);background:var(--bg);color:var(--tx);min-width:220px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px}
.kv{border:1px solid var(--bd);border-radius:8px;padding:11px 13px}
.kv .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--tx2)}
.kv .v{font-size:16px;font-weight:600;margin-top:3px;word-break:break-word}
.tag{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:600}
.t-ok{background:var(--okbg);color:var(--ok)} .t-er{background:var(--erbg);color:var(--er)}
.t-wa{background:var(--wabg);color:var(--wa)}
.mono{font-family:var(--mono);font-size:12px;word-break:break-all}
pre{background:var(--bg);border:1px solid var(--bd);border-radius:8px;padding:12px;
  overflow:auto;max-height:340px;font-size:12px;font-family:var(--mono)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd)}
th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--tx2)}
tr.sel{background:var(--okbg)}
.muted{color:var(--tx2);font-size:13px}
.hide{display:none}
#toast{position:fixed;right:18px;bottom:18px;background:var(--card);border:1px solid var(--bd);
  border-left:3px solid var(--ac);border-radius:8px;padding:11px 15px;box-shadow:0 6px 22px #0003;
  max-width:400px;opacity:0;transform:translateY(8px);transition:.18s}
#toast.on{opacity:1;transform:none}
#qr img{width:270px;height:270px;image-rendering:pixelated;background:#fff;padding:9px;border-radius:8px}
label.chk{display:flex;gap:9px;align-items:center;padding:7px 9px;border-radius:7px;cursor:pointer}
label.chk:hover{background:var(--bg)}
label.fld{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--tx2)}
label.fld input{min-width:0;width:100%}
label.fld small{font-size:11px}
</style>
</head>
<body>
<header>
  <h1>HUB WuzAPI &harr; Chatwoot</h1>
  <span id="build" class="muted"></span>
  <span class="sp"></span>
  <input type="password" id="tok" placeholder="Admin token" autocomplete="off">
  <button class="pri" id="entrar">Entrar</button>
  <button id="sair" class="hide">Sair</button>
</header>

<main>
  <div id="login" class="card">
    <h2>Autenticacao</h2>
    <p class="muted">Informe o <code>ADMIN_TOKEN</code> do HUB. Ele fica apenas na aba atual
    do navegador (<code>sessionStorage</code>) e nao e gravado em disco.</p>
  </div>

  <div id="app" class="hide">
    <div class="card">
      <h2>Saude do servico</h2>
      <div class="grid" id="saude"></div>
    </div>

    <div class="card">
      <h2>Instancias</h2>
      <div class="row" style="margin-bottom:12px">
        <select id="tenants"></select>
        <button id="recarregar">Recarregar</button>
        <button id="provisionar">Reprovisionar</button>
        <button id="conectar">Conectar sessao</button>
        <span class="sp" style="flex:1"></span>
        <button class="pri" id="abrirNova">+ Nova instancia</button>
      </div>
      <div class="grid" id="resumo"></div>
    </div>

    <div class="card hide" id="novaCard">
      <h2>Nova instancia</h2>
      <p class="muted">Antes de cadastrar aqui, crie o usuario no WuzAPI e tenha o
      <strong>token dele</strong> em maos. Ao salvar, o HUB cria um inbox de canal API no
      Chatwoot e grava o webhook no WuzAPI.</p>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
        <label class="fld">Identificador (slug)
          <input type="text" id="n_slug" placeholder="loja-centro">
          <small class="muted">minusculas, numeros e hifen. Vai na URL do webhook.</small></label>
        <label class="fld">Nome exibido
          <input type="text" id="n_name" placeholder="Loja Centro - WhatsApp">
          <small class="muted">Vira o nome do inbox no Chatwoot.</small></label>
        <label class="fld">URL do WuzAPI
          <input type="text" id="n_wurl"></label>
        <label class="fld">Token da instancia WuzAPI
          <input type="password" id="n_wtok" autocomplete="off"></label>
        <label class="fld">URL do Chatwoot
          <input type="text" id="n_curl"></label>
        <label class="fld">ID da conta no Chatwoot
          <input type="text" id="n_cacc" placeholder="1"></label>
        <label class="fld">Token do Chatwoot
          <input type="password" id="n_ctok" autocomplete="off">
          <small class="muted">Perfil &rarr; Access Token, de um usuario com acesso a conta.</small></label>
      </div>
      <div class="row" style="margin-top:12px">
        <label class="chk"><input type="checkbox" id="n_grupos"> Atender grupos</label>
        <span class="sp" style="flex:1"></span>
        <button id="cancelarNova">Cancelar</button>
        <button class="pri" id="salvarNova">Criar e provisionar</button>
      </div>
      <div id="novaResultado"></div>
    </div>

    <div class="card" id="qrcard">
      <h2>Pareamento</h2>
      <div id="qr"></div>
    </div>

    <div class="card">
      <h2>Comportamento</h2>
      <div id="flags" class="grid"></div>
    </div>

    <div class="card">
      <h2>Grupos do WhatsApp</h2>
      <div class="row" style="margin-bottom:10px">
        <input type="text" id="filtro" placeholder="Filtrar por nome">
        <button id="carregarGrupos">Carregar grupos</button>
        <button class="pri" id="salvarGrupos" disabled>Salvar selecao</button>
        <button id="limparGrupos">Limpar selecao</button>
      </div>
      <p class="muted" id="grupoInfo">Nenhum grupo carregado. Selecao vazia significa
      <strong>todos os grupos</strong> quando "Atender grupos" estiver ligado.</p>
      <div id="grupos"></div>
    </div>

    <div class="card">
      <h2>Ultimos webhooks recebidos</h2>
      <div class="row" style="margin-bottom:10px">
        <button id="carregarCap">Carregar capturas</button>
        <span class="muted">Exige <code>CAPTURE_RAW_WEBHOOKS=true</code>. Contem conteudo de conversas.</span>
      </div>
      <div id="capturas"></div>
    </div>
  </div>
</main>
<div id="toast"></div>

<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var token = sessionStorage.getItem('hubtok') || '';
  var slug = null, grupos = [], selecionados = {};

  function toast(msg, erro){
    var t = $('toast');
    t.textContent = msg;
    t.style.borderLeftColor = erro ? 'var(--er)' : 'var(--ac)';
    t.classList.add('on');
    clearTimeout(t._h);
    t._h = setTimeout(function(){ t.classList.remove('on'); }, 4200);
  }

  function api(path, opts){
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function(r){
      return r.text().then(function(t){
        var d = null;
        try { d = JSON.parse(t); } catch(e) { d = { erro: t }; }
        if (!r.ok) throw new Error((d && (d.error || d.erro)) || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function kv(k, v, classe){
    return '<div class="kv"><div class="k">' + esc(k) + '</div><div class="v ' +
      (classe || '') + '">' + v + '</div></div>';
  }
  function tag(txt, tipo){ return '<span class="tag t-' + tipo + '">' + esc(txt) + '</span>'; }

  /* ------------------------------- sessao -------------------------------- */

  function entrar(){
    var v = $('tok').value.trim();
    if (!v) return toast('Informe o token.', true);
    token = v;
    api('/admin/tenants').then(function(){
      sessionStorage.setItem('hubtok', token);
      $('login').classList.add('hide');
      $('app').classList.remove('hide');
      $('sair').classList.remove('hide');
      $('tok').value = '';
      iniciar();
    }).catch(function(e){ toast('Token recusado: ' + e.message, true); });
  }

  function sair(){
    sessionStorage.removeItem('hubtok');
    location.reload();
  }

  /* -------------------------------- dados -------------------------------- */

  function saude(){
    fetch('/health').then(function(r){ return r.json(); }).then(function(h){
      $('build').textContent = 'build ' + (h.build || '?');
      var q = h.queues || { inbound:{}, outbound:{} };
      $('saude').innerHTML =
        kv('Status', tag(h.status, h.status === 'ok' ? 'ok' : 'er')) +
        kv('Postgres', tag(h.database, h.database === 'ok' ? 'ok' : 'er')) +
        kv('Redis', tag(h.redis, h.redis === 'ok' ? 'ok' : 'er')) +
        kv('Fila entrada', 'aguard. ' + (q.inbound.waiting||0) + ' / falhas ' + (q.inbound.failed||0),
           (q.inbound.failed ? 'mono' : '')) +
        kv('Fila saida', 'aguard. ' + (q.outbound.waiting||0) + ' / falhas ' + (q.outbound.failed||0));
    }).catch(function(e){ toast('Falha ao ler /health: ' + e.message, true); });
  }

  function listarTenants(){
    return api('/admin/tenants').then(function(r){
      var d = r.data || [];
      $('tenants').innerHTML = d.map(function(t){
        return '<option value="' + esc(t.slug) + '">' + esc(t.name) + ' (' + esc(t.slug) + ')</option>';
      }).join('');
      if (d.length) { slug = slug || d[0].slug; $('tenants').value = slug; }
      return d;
    });
  }

  function detalhes(){
    if (!slug) return;
    api('/admin/tenants/' + slug + '/status').then(function(s){
      var ses = s.wuzapi_session || {}, wh = s.wuzapi_webhook || {}, ib = s.chatwoot_inbox || {};
      var esp = s.expected_webhooks || {};
      var urlW = wh.webhook || wh.WebhookURL || '';
      var okW = urlW === esp.wuzapi, okC = (ib.webhook_url || '') === esp.chatwoot;
      var lig = ses.connected && (ses.loggedIn || ses.LoggedIn);

      $('resumo').innerHTML =
        kv('Sessao WhatsApp', lig ? tag('conectada','ok') : tag('desconectada','er')) +
        kv('Conta', esc(ses.name || '-')) +
        kv('Webhook WuzAPI', okW ? tag('correto','ok') : tag('divergente','er')) +
        kv('Inbox Chatwoot', ib.id ? ('#' + esc(ib.id) + ' ' + (okC ? tag('correto','ok') : tag('divergente','er'))) : tag('ausente','er')) +
        kv('Eventos', '<span class="mono">' + esc(JSON.stringify(wh.subscribe || wh.events || [])) + '</span>');

      if (!okW || !okC) toast('Webhook divergente. Use "Reprovisionar".', true);
      qr(lig);
    }).catch(function(e){ toast('Status: ' + e.message, true); });

    api('/admin/tenants/' + slug).then(function(r){ flags(r.data); });
  }

  function qr(conectada){
    if (conectada) {
      $('qr').innerHTML = '<p class="muted">Sessao pareada. O QR so aparece quando a sessao esta desconectada.</p>';
      return;
    }
    $('qr').innerHTML = '<p class="muted">Buscando QR...</p>';
    api('/admin/tenants/' + slug + '/qr').then(function(q){
      var img = q.qrcode || '';
      if (img && img.indexOf('data:image') === 0) {
        $('qr').innerHTML = '<img src="' + esc(img) + '" alt="QR code">' +
          '<p class="muted">Leia no WhatsApp: Aparelhos conectados &rarr; Conectar aparelho.</p>';
      } else {
        $('qr').innerHTML = '<p class="muted">' + esc(q.mensagem || 'QR indisponivel.') +
          '</p>' + (q.detalhe ? '<p class="mono muted">' + esc(q.detalhe) + '</p>' : '');
      }
    }).catch(function(e){ $('qr').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
  }

  /* -------------------------------- flags -------------------------------- */

  var FLAGS = [
    ['handle_groups','Atender grupos'],
    ['group_sender_prefix','Prefixar nome do participante'],
    ['mirror_own_messages','Espelhar mensagens do celular'],
    ['reopen_resolved','Reabrir conversa resolvida'],
    ['active','Instancia ativa']
  ];

  function flags(t){
    if (!t) return;
    $('flags').innerHTML = FLAGS.map(function(f){
      return '<label class="chk"><input type="checkbox" data-f="' + f[0] + '"' +
        (t[f[0]] ? ' checked' : '') + '> ' + esc(f[1]) + '</label>';
    }).join('');
    Array.prototype.forEach.call($('flags').querySelectorAll('input'), function(el){
      el.addEventListener('change', function(){
        var corpo = {};
        corpo[el.dataset.f] = el.checked;
        api('/admin/tenants/' + slug, { method:'PATCH', body: corpo })
          .then(function(){ toast('Salvo: ' + el.dataset.f + ' = ' + el.checked); })
          .catch(function(e){ el.checked = !el.checked; toast('Falhou: ' + e.message, true); });
      });
    });
    selecionados = {};
    (t.group_allowlist || []).forEach(function(j){ selecionados[j] = true; });
  }

  /* -------------------------------- grupos ------------------------------- */

  function carregarGrupos(){
    $('grupos').innerHTML = '<p class="muted">Carregando...</p>';
    api('/admin/tenants/' + slug + '/groups').then(function(r){
      grupos = r.grupos || [];
      grupos.forEach(function(g){ if (g.permitido && r.modo !== 'todos os grupos') selecionados[g.jid] = true; });
      $('grupoInfo').innerHTML = 'Total: <strong>' + grupos.length + '</strong> grupos. Modo atual: <strong>' +
        esc(r.modo) + '</strong>. Selecao vazia = todos os grupos.';
      $('salvarGrupos').disabled = false;
      pintarGrupos();
    }).catch(function(e){ $('grupos').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
  }

  function pintarGrupos(){
    var f = $('filtro').value.toLowerCase();
    var vis = grupos.filter(function(g){ return !f || g.nome.toLowerCase().indexOf(f) >= 0; });
    if (!vis.length) { $('grupos').innerHTML = '<p class="muted">Nenhum grupo corresponde ao filtro.</p>'; return; }
    $('grupos').innerHTML =
      '<table><thead><tr><th style="width:40px"></th><th>Grupo</th><th style="width:110px">Participantes</th><th>JID</th></tr></thead><tbody>' +
      vis.map(function(g){
        return '<tr class="' + (selecionados[g.jid] ? 'sel' : '') + '">' +
          '<td><input type="checkbox" data-jid="' + esc(g.jid) + '"' + (selecionados[g.jid] ? ' checked' : '') + '></td>' +
          '<td>' + esc(g.nome) + '</td><td>' + g.participantes + '</td>' +
          '<td class="mono">' + esc(g.jid) + '</td></tr>';
      }).join('') + '</tbody></table>';
    Array.prototype.forEach.call($('grupos').querySelectorAll('input'), function(el){
      el.addEventListener('change', function(){
        if (el.checked) selecionados[el.dataset.jid] = true; else delete selecionados[el.dataset.jid];
        el.closest('tr').classList.toggle('sel', el.checked);
        atualizaContagem();
      });
    });
    atualizaContagem();
  }

  function atualizaContagem(){
    var n = Object.keys(selecionados).length;
    $('salvarGrupos').textContent = n ? ('Salvar ' + n + ' grupo(s)') : 'Salvar (liberar todos)';
  }

  function salvarGrupos(){
    var jids = Object.keys(selecionados);
    api('/admin/tenants/' + slug + '/groups/allowlist', { method:'PUT', body:{ group_allowlist: jids } })
      .then(function(r){ toast('Lista salva: ' + r.modo); carregarGrupos(); })
      .catch(function(e){ toast('Falhou: ' + e.message, true); });
  }

  /* ------------------------------- capturas ------------------------------ */

  function carregarCap(){
    api('/admin/tenants/' + slug + '/captures?limit=10').then(function(r){
      var c = r.capturas || [];
      if (!c.length) {
        $('capturas').innerHTML = '<p class="muted">Buffer vazio. ' +
          (r.stats && r.stats.habilitado ? 'Aguardando eventos.' : 'Captura desligada.') + '</p>';
        return;
      }
      $('capturas').innerHTML = c.map(function(x){
        return '<details><summary>' + esc(x.at) + ' &middot; <strong>' + esc(x.source) +
          '</strong> &middot; ' + esc(x.hint) + '</summary><pre>' +
          esc(JSON.stringify(x.body, null, 2)) + '</pre></details>';
      }).join('');
    }).catch(function(e){ $('capturas').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; });
  }

  /* --------------------------- nova instancia ---------------------------- */

  function abrirNova(){
    $('novaCard').classList.remove('hide');
    $('novaResultado').innerHTML = '';
    api('/admin/config').then(function(c){
      if (!$('n_wurl').value) $('n_wurl').value = c.default_wuzapi_base_url || '';
      if (!$('n_curl').value) $('n_curl').value = c.default_chatwoot_base_url || '';
    }).catch(function(){});
    $('novaCard').scrollIntoView({ behavior:'smooth', block:'start' });
  }

  function salvarNova(){
    var corpo = {
      slug: $('n_slug').value.trim(),
      name: $('n_name').value.trim(),
      wuzapi_base_url: $('n_wurl').value.trim(),
      wuzapi_token: $('n_wtok').value,
      chatwoot_base_url: $('n_curl').value.trim(),
      chatwoot_account_id: Number($('n_cacc').value.trim()),
      chatwoot_api_token: $('n_ctok').value,
      handle_groups: $('n_grupos').checked,
      provision: true
    };
    if (!corpo.slug || !corpo.name || !corpo.wuzapi_token || !corpo.chatwoot_api_token || !corpo.chatwoot_account_id) {
      return toast('Preencha todos os campos.', true);
    }

    $('salvarNova').disabled = true;
    api('/admin/tenants', { method:'POST', body: corpo }).then(function(r){
      var t = r.tenant || r.data || {};
      var w = r.webhooks || t.webhooks || {};
      var falha = r.provision_error;
      $('novaResultado').innerHTML =
        '<div class="grid" style="margin-top:14px">' +
        kv('Instancia', esc(t.slug || corpo.slug)) +
        kv('Inbox Chatwoot', t.chatwoot_inbox_id ? ('#' + esc(t.chatwoot_inbox_id) + ' ' + tag('criado','ok')) : tag('nao criado','er')) +
        kv('Webhook WuzAPI', falha ? tag('falhou','er') : tag('configurado','ok')) +
        '</div>' +
        (falha ? '<p class="mono" style="color:var(--er)">' + esc(falha) + '</p>' : '') +
        '<p class="muted mono">' + esc(w.wuzapi || '') + '</p>';

      toast(falha ? 'Criada, mas o provisionamento falhou.' : 'Instancia criada e provisionada.', !!falha);
      ['n_slug','n_name','n_wtok','n_ctok','n_cacc'].forEach(function(id){ $(id).value = ''; });
      slug = corpo.slug;
      listarTenants().then(function(){ $('tenants').value = slug; detalhes(); });
    }).catch(function(e){
      toast('Falhou: ' + e.message, true);
    }).finally(function(){ $('salvarNova').disabled = false; });
  }

  /* -------------------------------- eventos ------------------------------ */

  function iniciar(){
    saude();
    listarTenants().then(detalhes);
    clearInterval(window._t);
    window._t = setInterval(saude, 15000);
  }

  $('entrar').addEventListener('click', entrar);
  $('tok').addEventListener('keydown', function(e){ if (e.key === 'Enter') entrar(); });
  $('sair').addEventListener('click', sair);
  $('tenants').addEventListener('change', function(){ slug = this.value; detalhes(); });
  $('recarregar').addEventListener('click', iniciar);
  $('filtro').addEventListener('input', pintarGrupos);
  $('carregarGrupos').addEventListener('click', carregarGrupos);
  $('salvarGrupos').addEventListener('click', salvarGrupos);
  $('limparGrupos').addEventListener('click', function(){ selecionados = {}; pintarGrupos(); });
  $('carregarCap').addEventListener('click', carregarCap);
  $('abrirNova').addEventListener('click', abrirNova);
  $('salvarNova').addEventListener('click', salvarNova);
  $('cancelarNova').addEventListener('click', function(){ $('novaCard').classList.add('hide'); });

  $('provisionar').addEventListener('click', function(){
    if (!confirm('Reprovisionar grava o webhook no WuzAPI e ajusta o inbox no Chatwoot. Continuar?')) return;
    api('/admin/tenants/' + slug + '/provision', { method:'POST' })
      .then(function(){ toast('Provisionado.'); detalhes(); })
      .catch(function(e){ toast('Falhou: ' + e.message, true); });
  });

  $('conectar').addEventListener('click', function(){
    api('/admin/tenants/' + slug + '/connect', { method:'POST' })
      .then(function(){ toast('Conexao solicitada.'); setTimeout(detalhes, 1500); })
      .catch(function(e){ toast('Falhou: ' + e.message, true); });
  });

  if (token) {
    $('tok').value = token;
    entrar();
  }
})();
</script>
</body>
</html>`;

export async function uiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ui', async (_req, reply) => {
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .send(PAGINA);
  });
}
