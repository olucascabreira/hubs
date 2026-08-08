export const GROUP_SUFFIX = '@g.us';
export const USER_SUFFIXES = ['@s.whatsapp.net', '@c.us'];
export const LID_SUFFIX = '@lid';

/** Normaliza qualquer forma de JID/telefone para `<user>@<server>`. */
export function normalizeJid(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';

  // Remove o device/agent do JID multi-device: 5511999:12@s.whatsapp.net
  const [userPart, serverPart] = raw.includes('@') ? raw.split('@', 2) : [raw, undefined];
  const user = (userPart ?? '').split(':', 1)[0] ?? '';

  if (!serverPart) {
    const digits = user.replace(/\D/g, '');
    return digits ? `${digits}@s.whatsapp.net` : '';
  }
  return `${user}@${serverPart}`;
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith(GROUP_SUFFIX);
}

export function isLidJid(jid: string): boolean {
  return jid.endsWith(LID_SUFFIX);
}

export function isBroadcastJid(jid: string): boolean {
  return jid.endsWith('@broadcast') || jid.startsWith('status@');
}

export function isNewsletterJid(jid: string): boolean {
  return jid.endsWith('@newsletter');
}

/** Parte numerica do JID. Vazio para grupos/lid/broadcast. */
export function jidToPhone(jid: string): string | null {
  if (!jid || isGroupJid(jid) || isLidJid(jid) || isBroadcastJid(jid) || isNewsletterJid(jid)) {
    return null;
  }
  const user = jid.split('@', 1)[0] ?? '';
  const digits = user.replace(/\D/g, '');
  return digits || null;
}

/** E.164 para o campo phone_number do Chatwoot. */
export function jidToE164(jid: string): string | null {
  const phone = jidToPhone(jid);
  return phone ? `+${phone}` : null;
}

/**
 * Destino aceito pelo WuzAPI no campo `Phone`. Grupos exigem o JID completo;
 * contatos individuais aceitam so o numero.
 */
export function jidToWuzapiTarget(jid: string): string {
  if (isGroupJid(jid) || isLidJid(jid)) return jid;
  return jidToPhone(jid) ?? jid;
}

/** Converte o source_id guardado no Chatwoot de volta para JID. */
export function sourceIdToJid(sourceId: string): string {
  const cleaned = sourceId.replace(/^wa:/, '');
  return normalizeJid(cleaned);
}
