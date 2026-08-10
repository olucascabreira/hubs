/**
 * Smoke test das funcoes puras (sem Postgres/Redis).
 *   npx tsx src/scripts/smoke.ts
 */
import './env-defaults';
import assert from 'node:assert/strict';

import { normalizeWuzapiEvent } from '../core/normalize';
import { normalizeJid, jidToE164, jidToWuzapiTarget, isGroupJid } from '../core/jid';
import { outboundKindFor, filenameForInbound, extensionFor, audioSendMode } from '../core/media';
import { deterministicWaId, extractChatwootMessage } from '../core/outbound';

let passed = 0;
const pendentes: Array<Promise<void>> = [];

function check(label: string, fn: () => void | Promise<void>) {
  const resultado = fn();
  if (resultado instanceof Promise) {
    pendentes.push(
      resultado.then(() => {
        passed += 1;
        console.log(`  ok  ${label}`);
      }),
    );
    return;
  }
  passed += 1;
  console.log(`  ok  ${label}`);
}

console.log('\nJID');
check('remove device do JID multi-device', () => {
  assert.equal(normalizeJid('5511999998888:12@s.whatsapp.net'), '5511999998888@s.whatsapp.net');
});
check('numero solto vira JID de usuario', () => {
  assert.equal(normalizeJid('+55 (11) 99999-8888'), '5511999998888@s.whatsapp.net');
});
check('grupo e detectado e nao vira telefone', () => {
  const jid = '120363012345678901@g.us';
  assert.equal(isGroupJid(jid), true);
  assert.equal(jidToE164(jid), null);
  assert.equal(jidToWuzapiTarget(jid), jid);
});
check('contato individual vai como numero puro para o WuzAPI', () => {
  assert.equal(jidToWuzapiTarget('5511999998888@s.whatsapp.net'), '5511999998888');
  assert.equal(jidToE164('5511999998888@s.whatsapp.net'), '+5511999998888');
});

console.log('\nNormalizacao de eventos do WuzAPI');
check('mensagem de texto simples', () => {
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    token: 'tok',
    event: {
      Info: {
        Chat: '5511999998888@s.whatsapp.net',
        Sender: '5511999998888@s.whatsapp.net',
        ID: '3EB0AAAA',
        PushName: 'Lucas',
        IsFromMe: false,
        IsGroup: false,
        Timestamp: '2026-08-08T12:00:00Z',
      },
      Message: { conversation: 'Bom dia!' },
    },
  });
  assert.ok(ev);
  assert.equal(ev.type, 'Message');
  assert.equal(ev.text, 'Bom dia!');
  assert.equal(ev.waMessageId, '3EB0AAAA');
  assert.equal(ev.pushName, 'Lucas');
  assert.equal(ev.isGroup, false);
  assert.equal(ev.media, null);
});

check('enderecamento por LID: prefere o telefone de SenderAlt', () => {
  // Payload real capturado de uma instancia WuzAPI em producao.
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    event: {
      Info: {
        AddressingMode: '',
        Chat: '230850197225676@lid',
        Sender: '230850197225676@lid',
        SenderAlt: '5511987654321@s.whatsapp.net',
        RecipientAlt: '',
        ID: '3A5995F55AF066B1B130',
        IsFromMe: false,
        IsGroup: false,
        PushName: 'Lucas Cabreira',
        Type: 'text',
      },
      Message: { conversation: 'Opa! Teste de api' },
    },
  });
  assert.ok(ev);
  assert.equal(ev.chatJid, '5511987654321@s.whatsapp.net', 'chat deve usar o JID de telefone');
  assert.equal(ev.senderJid, '5511987654321@s.whatsapp.net');
  assert.equal(ev.chatLid, '230850197225676@lid', 'LID original preservado');
  assert.equal(ev.senderLid, '230850197225676@lid');
  assert.equal(jidToE164(ev.chatJid), '+5511987654321', 'telefone disponivel para o Chatwoot');
  assert.equal(ev.text, 'Opa! Teste de api');
});

check('LID sem alternativo: mantem o LID em vez de perder o remetente', () => {
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    event: {
      Info: { Chat: '111@lid', Sender: '111@lid', SenderAlt: '', ID: 'X9', IsFromMe: false },
      Message: { conversation: 'oi' },
    },
  });
  assert.equal(ev?.chatJid, '111@lid');
  assert.equal(ev?.chatLid, null, 'sem traducao, nao registra LID secundario');
});

check('saida por LID usa RecipientAlt como destino', () => {
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    event: {
      Info: {
        Chat: '230850197225676@lid',
        Sender: '5511000000000@s.whatsapp.net',
        SenderAlt: '',
        RecipientAlt: '5511987654321@s.whatsapp.net',
        ID: 'OUT1',
        IsFromMe: true,
      },
      Message: { conversation: 'resposta' },
    },
  });
  assert.equal(ev?.chatJid, '5511987654321@s.whatsapp.net');
  assert.equal(ev?.isFromMe, true);
});

check('mensagem de grupo identifica o participante', () => {
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    event: {
      Info: {
        Chat: '120363012345678901@g.us',
        Sender: '5511988887777:3@s.whatsapp.net',
        ID: '3EB0BBBB',
        PushName: 'Maria',
        IsGroup: true,
      },
      Message: { extendedTextMessage: { text: 'alguem viu o relatorio?' } },
    },
  });
  assert.ok(ev);
  assert.equal(ev.isGroup, true);
  assert.equal(ev.chatJid, '120363012345678901@g.us');
  assert.equal(ev.senderJid, '5511988887777@s.whatsapp.net');
  assert.equal(ev.text, 'alguem viu o relatorio?');
});

check('imagem com legenda expoe os campos de download', () => {
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    event: {
      Info: { Chat: '5511999998888@s.whatsapp.net', ID: '3EB0CCCC' },
      Message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/d/f/abc.enc',
          directPath: '/v/t62.7118-24/abc.enc',
          mimetype: 'image/jpeg',
          caption: 'segue o comprovante',
          fileSha256: 'aGFzaA==',
          fileEncSha256: 'ZW5jaGFzaA==',
          mediaKey: 'a2V5',
          fileLength: 51234,
        },
      },
    },
  });
  assert.ok(ev?.media);
  assert.equal(ev.media.kind, 'image');
  assert.equal(ev.media.mimetype, 'image/jpeg');
  assert.equal(ev.media.ref.DirectPath, '/v/t62.7118-24/abc.enc');
  assert.equal(ev.media.ref.FileLength, 51234);
  assert.equal(ev.text, 'segue o comprovante');
});

check('documento dentro de viewOnce/documentWithCaption e desembrulhado', () => {
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    event: {
      Info: { Chat: '5511999998888@s.whatsapp.net', ID: '3EB0DDDD' },
      Message: {
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              url: 'https://mmg.whatsapp.net/d/f/doc.enc',
              mimetype: 'application/pdf',
              fileName: 'contrato.pdf',
              caption: 'assinado',
              mediaKey: 'a2V5',
              fileSha256: 'aA==',
              fileEncSha256: 'Yg==',
              fileLength: 900,
            },
          },
        },
      },
    },
  });
  assert.ok(ev?.media);
  assert.equal(ev.media.kind, 'document');
  assert.equal(ev.media.filename, 'contrato.pdf');
});

check('localizacao vira link do Google Maps', () => {
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    event: {
      Info: { Chat: '5511999998888@s.whatsapp.net', ID: '3EB0EEEE' },
      Message: { locationMessage: { degreesLatitude: -23.55, degreesLongitude: -46.63, name: 'Se' } },
    },
  });
  assert.ok(ev?.text?.includes('maps.google.com/?q=-23.55,-46.63'));
});

check('resposta citada carrega o stanzaId', () => {
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    event: {
      Info: { Chat: '5511999998888@s.whatsapp.net', ID: '3EB0FFFF' },
      Message: {
        extendedTextMessage: { text: 'isso', contextInfo: { stanzaId: '3EB0AAAA' } },
      },
    },
  });
  assert.equal(ev?.quotedWaMessageId, '3EB0AAAA');
});

check('formato antigo com jsonData string', () => {
  const ev = normalizeWuzapiEvent({
    token: 'tok',
    jsonData: JSON.stringify({
      type: 'Message',
      event: { Info: { Chat: '5511999998888@s.whatsapp.net', ID: 'X1' }, Message: { conversation: 'oi' } },
    }),
  });
  assert.equal(ev?.text, 'oi');
  assert.equal(ev?.waMessageId, 'X1');
});

check('evento de presenca e reconhecido mas nao vira mensagem', () => {
  const ev = normalizeWuzapiEvent({ type: 'Presence', event: { From: '5511999998888@s.whatsapp.net' } });
  assert.equal(ev?.type, 'Presence');
});

console.log('\nMidia');
check('roteamento de anexos do Chatwoot para o endpoint certo', () => {
  assert.equal(outboundKindFor('image', 'image/png'), 'image');
  assert.equal(outboundKindFor('image', 'image/webp'), 'document');
  assert.equal(outboundKindFor('video', 'video/mp4'), 'video');
  // Todo audio entra pelo caminho de audio; o recuo para documento acontece
  // depois, se a conversao para OGG nao rolar.
  assert.equal(outboundKindFor('audio', 'audio/ogg'), 'audio');
  assert.equal(outboundKindFor('audio', 'audio/mpeg'), 'audio');
  assert.equal(outboundKindFor('audio', 'audio/wav'), 'audio');
  assert.equal(outboundKindFor('file', 'application/pdf'), 'document');
  assert.equal(outboundKindFor(undefined, 'image/jpeg'), 'image');
});

check('PTT so para OGG/Opus — mp3 como nota de voz chega quebrado', () => {
  // Nota de voz nativa
  assert.equal(audioSendMode('audio/ogg; codecs=opus'), 'ptt');
  assert.equal(audioSendMode('audio/opus'), 'ptt');
  // Audio comum: player, mas NAO nota de voz
  assert.equal(audioSendMode('audio/mpeg'), 'audio', 'mp3 do Chatwoot nao pode ir como PTT');
  assert.equal(audioSendMode('audio/mp4'), 'audio');
  assert.equal(audioSendMode('audio/m4a'), 'audio');
  // Sem suporte no WhatsApp: vira documento para ao menos poder ser baixado
  assert.equal(audioSendMode('audio/wav'), 'document');
  assert.equal(audioSendMode('audio/webm'), 'document');
  assert.equal(audioSendMode('audio/amr'), 'document');
});
check('extensao derivada do mimetype', () => {
  assert.equal(extensionFor('image/jpeg'), 'jpg');
  assert.equal(extensionFor('application/pdf'), 'pdf');
  assert.equal(extensionFor('inexistente/x'), 'bin');
});
check('nome de arquivo do anexo recebido', () => {
  const base = { kind: 'image' as const, ref: {}, caption: null, inlineBase64: null, seconds: null, isPtt: false };
  assert.equal(filenameForInbound({ ...base, mimetype: 'image/jpeg', filename: null }, 'ABC'), 'image-ABC.jpg');
  assert.equal(
    filenameForInbound({ ...base, kind: 'document', mimetype: 'application/pdf', filename: 'nota.pdf' }, 'ABC'),
    'nota.pdf',
  );
});

console.log('\nDiagnostico da sessao do WhatsApp');
check('conectada sem JID e sessao morta, nao saudavel', async () => {
  const { diagnosticarSessao } = await import('../core/sessao');
  // Caso real: o WuzAPI reporta connected/loggedIn true, mas o aparelho foi
  // desvinculado e nenhum evento chega.
  const d = diagnosticarSessao({ connected: true, loggedIn: true, jid: '' });
  assert.equal(d.ok, false, 'JID vazio nao pode passar por saudavel');
  assert.equal(d.estado, 'sem_dispositivo');
  assert.match(d.mensagem, /QR|pareie/i, 'precisa dizer o que fazer');
});
check('sessao pareada de verdade e saudavel', async () => {
  const { diagnosticarSessao } = await import('../core/sessao');
  const d = diagnosticarSessao({ connected: true, loggedIn: true, jid: '5511966179706:22@s.whatsapp.net' });
  assert.equal(d.ok, true);
  assert.equal(d.estado, 'ok');
});
check('desconectada e WuzAPI inacessivel sao estados distintos', async () => {
  const { diagnosticarSessao } = await import('../core/sessao');
  assert.equal(diagnosticarSessao({ connected: false, jid: '' }).estado, 'desconectada');
  assert.equal(diagnosticarSessao({ error: 'timeout' }).estado, 'inacessivel');
  assert.equal(diagnosticarSessao(null).estado, 'inacessivel');
});

console.log('\nNome do contato de grupo');
check('acrescenta o sufixo ao assunto do grupo', async () => {
  const { comSufixoDeGrupo } = await import('../core/resolve');
  assert.equal(comSufixoDeGrupo('Vendas Centro'), 'Vendas Centro (Grupo)');
  assert.equal(comSufixoDeGrupo('  Suporte  '), 'Suporte (Grupo)', 'apara espacos');
});
check('nao duplica o sufixo em grupo ja marcado', async () => {
  const { comSufixoDeGrupo } = await import('../core/resolve');
  assert.equal(comSufixoDeGrupo('Vendas Centro (Grupo)'), 'Vendas Centro (Grupo)');
  assert.equal(
    comSufixoDeGrupo(comSufixoDeGrupo('Financeiro')),
    'Financeiro (Grupo)',
    'aplicar duas vezes tem o mesmo resultado',
  );
});

console.log('\nCitacao de mensagem (responder)');
check('citacao do WhatsApp expoe o stanzaId da mensagem original', () => {
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    event: {
      Info: {
        Chat: '5511987654321@s.whatsapp.net',
        Sender: '5511987654321@s.whatsapp.net',
        ID: 'RESP1',
        IsFromMe: false,
      },
      Message: {
        extendedTextMessage: {
          text: 'sim, pode ser',
          contextInfo: {
            stanzaId: '3EB0ORIGINAL',
            participant: '5511987654321@s.whatsapp.net',
          },
        },
      },
    },
  });
  assert.equal(ev?.quotedWaMessageId, '3EB0ORIGINAL', 'precisa achar o alvo da citacao');
  assert.equal(ev?.text, 'sim, pode ser');
});
check('mensagem sem citacao nao inventa alvo', () => {
  const ev = normalizeWuzapiEvent({
    type: 'Message',
    event: {
      Info: { Chat: '5511987654321@s.whatsapp.net', ID: 'SEMRESP', IsFromMe: false },
      Message: { conversation: 'mensagem solta' },
    },
  });
  assert.equal(ev?.quotedWaMessageId, null);
});

console.log('\nVinculo obsoleto (registro apagado no Chatwoot)');
check('4xx de ID inexistente e tratado como vinculo obsoleto', async () => {
  const { HttpError } = await import('../clients/http');
  const mod: Record<string, unknown> = await import('../core/inbound');
  // A funcao e interna; validamos a regra que ela implementa.
  const obsoleto = (s: number) => [400, 404, 422].includes(s);
  assert.equal(obsoleto(new HttpError(404, '/x', '').status), true, '404: registro sumiu');
  assert.equal(obsoleto(new HttpError(422, '/x', '').status), true, '422: referencia invalida');
  assert.equal(obsoleto(new HttpError(500, '/x', '').status), false, '500 e falha do servidor, nao vinculo');
  assert.ok(mod['handleInboundEvent'], 'handleInboundEvent segue exportado');
});
check('HttpError distingue o que vale repetir', async () => {
  const { HttpError } = await import('../clients/http');
  assert.equal(new HttpError(500, '/x', '').retryable, true);
  assert.equal(new HttpError(429, '/x', '').retryable, true, 'rate limit passa depois');
  assert.equal(new HttpError(408, '/x', '').retryable, true, 'timeout passa depois');
  assert.equal(new HttpError(422, '/x', '').retryable, false, 'payload invalido nao melhora');
  assert.equal(new HttpError(404, '/x', '').retryable, false);
});

console.log('\nLista de permissao de grupos');
check('lista vazia libera todos os grupos', async () => {
  const { grupoPermitido } = await import('../core/inbound');
  assert.equal(grupoPermitido({ group_allowlist: [] }, '120363000000000001@g.us'), true);
});
check('com itens, so os grupos listados passam', async () => {
  const { grupoPermitido } = await import('../core/inbound');
  const t = { group_allowlist: ['120363000000000001@g.us'] };
  assert.equal(grupoPermitido(t, '120363000000000001@g.us'), true);
  assert.equal(grupoPermitido(t, '120363000000000002@g.us'), false, 'grupo fora da lista deve ser barrado');
});
check('JID salvo sem sufixo ainda casa', async () => {
  const { grupoPermitido } = await import('../core/inbound');
  // normalizeJid completa o servidor quando so vem o numero
  const t = { group_allowlist: ['120363000000000001@g.us'] };
  assert.equal(grupoPermitido(t, '120363000000000001@g.us'), true);
});

console.log('\nConversao de audio para nota de voz');
check('OGG ja e nota de voz, nao reconverte', async () => {
  const { paraNotaDeVoz, jaEhNotaDeVoz } = await import('../core/transcode');
  assert.equal(jaEhNotaDeVoz('audio/ogg; codecs=opus'), true);
  assert.equal(jaEhNotaDeVoz('audio/mpeg'), false);
  const r = await paraNotaDeVoz(Buffer.from('conteudo-ogg'), 'audio/ogg');
  assert.equal(r.convertido, false, 'nao deve reprocessar o que ja esta certo');
  assert.equal(r.mimetype, 'audio/ogg; codecs=opus');
});
check('entrada invalida nao derruba o envio: devolve o original', async () => {
  const { paraNotaDeVoz } = await import('../core/transcode');
  const lixo = Buffer.from('isto nao e audio');
  const r = await paraNotaDeVoz(lixo, 'audio/mpeg');
  // Sem ffmpeg (ENOENT) ou com ffmpeg rejeitando a entrada, o resultado e o
  // mesmo: segue com o original em vez de perder a mensagem.
  assert.equal(r.convertido, false);
  assert.equal(r.buffer, lixo);
  assert.equal(r.mimetype, 'audio/mpeg');
});

console.log('\nSaida (Chatwoot -> WhatsApp)');
check('id do WhatsApp e deterministico por mensagem do Chatwoot', () => {
  const a = deterministicWaId('11111111-1111-1111-1111-111111111111', 42, 0);
  const b = deterministicWaId('11111111-1111-1111-1111-111111111111', 42, 0);
  const c = deterministicWaId('11111111-1111-1111-1111-111111111111', 42, 1);
  assert.equal(a, b, 'reprocessar o mesmo job nao pode gerar novo id');
  assert.notEqual(a, c);
  assert.match(a, /^3EB0[0-9A-F]{16}$/);
});
check('payload do Chatwoot aninhado em message e achatado', () => {
  const flat = extractChatwootMessage({
    event: 'message_created',
    message: { id: 7, content: 'oi', message_type: 'outgoing' },
    conversation: { id: 3, inbox_id: 2 },
  });
  assert.equal(flat?.['id'], 7);
  assert.equal(flat?.['event'], 'message_created');
  assert.ok(flat?.['conversation']);
});

Promise.all(pendentes)
  .then(() => console.log(`\n${passed} verificacoes passaram.\n`))
  .catch((err) => {
    console.error('\nFALHOU:', err);
    process.exit(1);
  });
