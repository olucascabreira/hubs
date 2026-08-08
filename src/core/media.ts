import type { NormalizedMedia } from './normalize';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

export function baseMime(mimetype: string): string {
  return (mimetype.split(';', 1)[0] ?? mimetype).trim().toLowerCase();
}

export function extensionFor(mimetype: string): string {
  return MIME_TO_EXT[baseMime(mimetype)] ?? 'bin';
}

/** Nome de arquivo estavel para o anexo criado no Chatwoot. */
export function filenameForInbound(media: NormalizedMedia, waMessageId: string | null): string {
  if (media.filename && /\.[A-Za-z0-9]{1,6}$/.test(media.filename)) return media.filename;

  const stem = media.filename?.replace(/[^\w.-]+/g, '_') ?? `${media.kind}-${waMessageId ?? Date.now()}`;
  return `${stem}.${extensionFor(media.mimetype)}`;
}

export type OutboundKind = 'image' | 'video' | 'audio' | 'document';

/**
 * Decide por qual endpoint do WuzAPI o anexo do Chatwoot deve sair.
 *
 * `file_type` do Chatwoot e a fonte primaria; o mime resolve os casos em que
 * o Chatwoot classifica tudo como `file`. Formatos de audio que o WhatsApp nao
 * reproduz nativamente viram documento para nao falhar no envio.
 */
export function outboundKindFor(fileType: string | undefined, mimetype: string): OutboundKind {
  const mime = baseMime(mimetype);

  if (fileType === 'image' || mime.startsWith('image/')) {
    // WhatsApp so aceita sticker via endpoint proprio; webp vai como documento.
    return mime === 'image/webp' ? 'document' : 'image';
  }
  if (fileType === 'video' || mime.startsWith('video/')) return 'video';
  if (fileType === 'audio' || mime.startsWith('audio/')) {
    return audioSendMode(mime) === 'document' ? 'document' : 'audio';
  }
  return 'document';
}

export type AudioMode = 'ptt' | 'audio' | 'document';

/**
 * Como enviar um audio ao WhatsApp.
 *
 * A distincao importa: `PTT` marca a mensagem como NOTA DE VOZ, e nota de voz
 * so aceita OGG/Opus. Marcar um mp3 como PTT produz uma mensagem que o app
 * nao reproduz nem permite baixar — falha silenciosa, sem erro no envio.
 */
export function audioSendMode(mimetype: string): AudioMode {
  const mime = baseMime(mimetype);

  // Nota de voz nativa.
  if (mime === 'audio/ogg' || mime === 'audio/opus') return 'ptt';

  // Audio comum: aparece com player, sem ser nota de voz.
  if (['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/m4a', 'audio/x-m4a'].includes(mime)) {
    return 'audio';
  }

  // wav, webm, amr e afins: o WhatsApp nao reproduz. Como documento ao menos
  // chega inteiro e pode ser baixado.
  return 'document';
}

export function toDataUri(mimetype: string, base64: string): string {
  return `data:${baseMime(mimetype)};base64,${base64}`;
}

export function guessFilename(name: string | undefined, mimetype: string, fallbackStem: string): string {
  if (name && /\.[A-Za-z0-9]{1,6}$/.test(name)) return name;
  return `${(name ?? fallbackStem).replace(/[^\w.-]+/g, '_')}.${extensionFor(mimetype)}`;
}
