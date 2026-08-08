import { normalizeJid, isGroupJid } from './jid';
import type { WuzMediaKind, WuzMediaRef } from '../clients/wuzapi';

export interface NormalizedMedia {
  kind: WuzMediaKind;
  ref: WuzMediaRef;
  mimetype: string;
  caption: string | null;
  filename: string | null;
  /** Preenchido quando o proprio WuzAPI ja entregou a midia decodificada. */
  inlineBase64: string | null;
  seconds: number | null;
  isPtt: boolean;
}

export interface NormalizedEvent {
  type: string;
  waMessageId: string | null;
  chatJid: string;
  senderJid: string;
  isFromMe: boolean;
  isGroup: boolean;
  pushName: string | null;
  timestamp: Date | null;
  text: string | null;
  media: NormalizedMedia | null;
  quotedWaMessageId: string | null;
  reaction: { emoji: string; targetId: string } | null;
  raw: unknown;
}

type Dict = Record<string, unknown>;

const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Leitura case-insensitive — o WuzAPI muda a capitalizacao entre versoes. */
function pick(obj: unknown, ...names: string[]): unknown {
  if (!isDict(obj)) return undefined;
  const lowered = new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) {
    const v = lowered.get(n.toLowerCase());
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null;

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** Aceita o corpo cru do webhook em qualquer um dos formatos conhecidos. */
export function unwrapWebhookBody(body: unknown): Dict | null {
  if (typeof body === 'string') {
    try {
      return unwrapWebhookBody(JSON.parse(body));
    } catch {
      return null;
    }
  }
  if (!isDict(body)) return null;

  // Formato antigo: form-encoded com o JSON dentro de `jsonData`.
  const jsonData = pick(body, 'jsonData');
  if (typeof jsonData === 'string') {
    try {
      const inner = JSON.parse(jsonData);
      return isDict(inner) ? { ...body, ...inner } : body;
    } catch {
      return body;
    }
  }
  return body;
}

/** Remove os envelopes de mensagem (ephemeral, viewOnce, deviceSent, ...). */
function unwrapMessage(message: unknown, depth = 0): Dict | null {
  if (!isDict(message) || depth > 6) return isDict(message) ? message : null;

  const wrappers = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'deviceSentMessage',
    'documentWithCaptionMessage',
    'editedMessage',
  ];

  for (const w of wrappers) {
    const wrapper = pick(message, w);
    if (isDict(wrapper)) {
      const inner = pick(wrapper, 'message');
      if (isDict(inner)) return unwrapMessage(inner, depth + 1);
    }
  }
  return message;
}

const MEDIA_NODES: Array<{ key: string; kind: WuzMediaKind }> = [
  { key: 'imageMessage', kind: 'image' },
  { key: 'videoMessage', kind: 'video' },
  { key: 'audioMessage', kind: 'audio' },
  { key: 'documentMessage', kind: 'document' },
  { key: 'stickerMessage', kind: 'sticker' },
  { key: 'ptvMessage', kind: 'video' },
];

const DEFAULT_MIME: Record<WuzMediaKind, string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/ogg',
  document: 'application/octet-stream',
  sticker: 'image/webp',
};

function extractMedia(message: Dict, envelope: Dict): NormalizedMedia | null {
  for (const { key, kind } of MEDIA_NODES) {
    const node = pick(message, key);
    if (!isDict(node)) continue;

    const mimetype = str(pick(node, 'mimetype', 'mimeType')) ?? DEFAULT_MIME[kind];

    const ref: WuzMediaRef = {
      Url: str(pick(node, 'url', 'URL')) ?? undefined,
      DirectPath: str(pick(node, 'directPath')) ?? undefined,
      MediaKey: str(pick(node, 'mediaKey')) ?? undefined,
      Mimetype: mimetype,
      FileEncSHA256: str(pick(node, 'fileEncSha256', 'fileEncSHA256')) ?? undefined,
      FileSHA256: str(pick(node, 'fileSha256', 'fileSHA256')) ?? undefined,
      FileLength: num(pick(node, 'fileLength')) ?? undefined,
    };

    return {
      kind,
      ref,
      mimetype,
      caption: str(pick(node, 'caption')),
      filename: str(pick(node, 'fileName', 'filename', 'title')),
      // Algumas builds do WuzAPI ja anexam a midia decodificada no webhook.
      inlineBase64: str(pick(envelope, 'base64', 'Base64', 'media', 'fileBase64')),
      seconds: num(pick(node, 'seconds')),
      isPtt: pick(node, 'ptt') === true,
    };
  }
  return null;
}

function extractText(message: Dict): string | null {
  const direct = str(pick(message, 'conversation'));
  if (direct) return direct;

  const candidates: Array<[string, string[]]> = [
    ['extendedTextMessage', ['text']],
    ['imageMessage', ['caption']],
    ['videoMessage', ['caption']],
    ['documentMessage', ['caption']],
    ['buttonsResponseMessage', ['selectedDisplayText', 'selectedButtonId']],
    ['listResponseMessage', ['title']],
    ['templateButtonReplyMessage', ['selectedDisplayText']],
    ['reactionMessage', ['text']],
    ['pollCreationMessage', ['name']],
  ];

  for (const [node, fields] of candidates) {
    const value = pick(message, node);
    if (!isDict(value)) continue;
    const found = str(pick(value, ...fields));
    if (found) return found;
  }

  const location = pick(message, 'locationMessage');
  if (isDict(location)) {
    const lat = num(pick(location, 'degreesLatitude'));
    const lng = num(pick(location, 'degreesLongitude'));
    const name = str(pick(location, 'name', 'address'));
    if (lat !== null && lng !== null) {
      const label = name ? `${name}\n` : '';
      return `📍 ${label}https://maps.google.com/?q=${lat},${lng}`;
    }
  }

  const contact = pick(message, 'contactMessage');
  if (isDict(contact)) {
    const name = str(pick(contact, 'displayName')) ?? 'Contato';
    const vcard = str(pick(contact, 'vcard')) ?? '';
    const phone = vcard.match(/waid=(\d+)/)?.[1];
    return `👤 ${name}${phone ? `\n+${phone}` : ''}`;
  }

  return null;
}

function extractQuotedId(message: Dict): string | null {
  for (const key of Object.keys(message)) {
    const node = (message as Dict)[key];
    if (!isDict(node)) continue;
    const ctx = pick(node, 'contextInfo');
    if (isDict(ctx)) {
      const stanza = str(pick(ctx, 'stanzaId', 'stanzaID'));
      if (stanza) return stanza;
    }
  }
  return null;
}

/**
 * Converte o payload cru do webhook do WuzAPI numa forma estavel.
 * Retorna null quando o corpo nao e reconhecivel.
 */
export function normalizeWuzapiEvent(body: unknown): NormalizedEvent | null {
  const envelope = unwrapWebhookBody(body);
  if (!envelope) return null;

  const type = str(pick(envelope, 'type', 'event_type', 'Type')) ?? 'Unknown';

  // O evento pode vir em `event` ou achatado na raiz.
  const eventNode = pick(envelope, 'event', 'Event');
  const event: Dict = isDict(eventNode) ? eventNode : envelope;

  const infoNode = pick(event, 'Info', 'info');
  const info: Dict = isDict(infoNode) ? infoNode : event;

  const chatJid = normalizeJid(str(pick(info, 'Chat', 'chat', 'RemoteJid', 'remoteJid')) ?? '');
  const senderJidRaw = str(pick(info, 'Sender', 'sender', 'participant')) ?? chatJid;
  const senderJid = normalizeJid(senderJidRaw);

  const rawMessage = pick(event, 'Message', 'message');
  const message = unwrapMessage(rawMessage) ?? {};

  const tsRaw = pick(info, 'Timestamp', 'timestamp', 'MessageTimestamp');
  let timestamp: Date | null = null;
  if (typeof tsRaw === 'string') {
    const parsed = new Date(tsRaw);
    timestamp = Number.isNaN(parsed.getTime()) ? null : parsed;
  } else if (typeof tsRaw === 'number') {
    timestamp = new Date(tsRaw > 1e12 ? tsRaw : tsRaw * 1000);
  }

  const reactionNode = pick(message, 'reactionMessage');
  let reaction: NormalizedEvent['reaction'] = null;
  if (isDict(reactionNode)) {
    const key = pick(reactionNode, 'key');
    const targetId = isDict(key) ? str(pick(key, 'id', 'ID')) : null;
    const emoji = str(pick(reactionNode, 'text'));
    if (targetId && emoji) reaction = { emoji, targetId };
  }

  return {
    type,
    waMessageId: str(pick(info, 'ID', 'Id', 'id')),
    chatJid,
    senderJid,
    isFromMe: pick(info, 'IsFromMe', 'isFromMe', 'fromMe') === true,
    isGroup: isGroupJid(chatJid) || pick(info, 'IsGroup', 'isGroup') === true,
    pushName: str(pick(info, 'PushName', 'pushName', 'notifyName')),
    timestamp,
    text: extractText(message),
    media: extractMedia(message, envelope),
    quotedWaMessageId: extractQuotedId(message),
    reaction,
    raw: body,
  };
}
