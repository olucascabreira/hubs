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
function check(label: string, fn: () => void) {
  fn();
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
        SenderAlt: '5519994983618@s.whatsapp.net',
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
  assert.equal(ev.chatJid, '5519994983618@s.whatsapp.net', 'chat deve usar o JID de telefone');
  assert.equal(ev.senderJid, '5519994983618@s.whatsapp.net');
  assert.equal(ev.chatLid, '230850197225676@lid', 'LID original preservado');
  assert.equal(ev.senderLid, '230850197225676@lid');
  assert.equal(jidToE164(ev.chatJid), '+5519994983618', 'telefone disponivel para o Chatwoot');
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
        RecipientAlt: '5519994983618@s.whatsapp.net',
        ID: 'OUT1',
        IsFromMe: true,
      },
      Message: { conversation: 'resposta' },
    },
  });
  assert.equal(ev?.chatJid, '5519994983618@s.whatsapp.net');
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
  assert.equal(outboundKindFor('audio', 'audio/ogg'), 'audio');
  assert.equal(outboundKindFor('audio', 'audio/mpeg'), 'audio');
  assert.equal(outboundKindFor('audio', 'audio/wav'), 'document');
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

console.log(`\n${passed} verificacoes passaram.\n`);
