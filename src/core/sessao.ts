/**
 * Diagnostico da sessao do WhatsApp.
 *
 * Fica em `core` de proposito: e regra de dominio pura, sem Postgres nem
 * Redis, para poder ser testada sem infraestrutura.
 */

export type EstadoSessao =
  | 'ok'
  | 'sem_dispositivo'
  | 'desconectada'
  | 'nao_autenticada'
  | 'inacessivel';

export interface DiagnosticoSessao {
  estado: EstadoSessao;
  ok: boolean;
  mensagem: string;
  jid?: string;
}

/**
 * O WuzAPI reporta `connected: true` mesmo quando o WhatsApp ja desvinculou o
 * aparelho — o socket segue vivo, mas nao ha dispositivo pareado e nenhum
 * evento chega. O sinal confiavel e o JID: vazio significa sessao morta.
 *
 * Esse caso ja ocorreu em producao: a instancia ficou 2 horas sem receber
 * nada enquanto o painel exibia "conectada".
 */
export function diagnosticarSessao(
  sessao: Record<string, unknown> | null,
): DiagnosticoSessao {
  if (!sessao || sessao['error']) {
    return { estado: 'inacessivel', ok: false, mensagem: 'Nao foi possivel consultar o WuzAPI.' };
  }

  const conectada = sessao['connected'] === true;
  const logada = sessao['loggedIn'] === true || sessao['LoggedIn'] === true;
  const jid = String(sessao['jid'] ?? sessao['Jid'] ?? '').trim();

  if (!conectada) {
    return {
      estado: 'desconectada',
      ok: false,
      mensagem: 'Sessao desconectada. Use "Conectar sessao".',
    };
  }
  if (!jid) {
    return {
      estado: 'sem_dispositivo',
      ok: false,
      mensagem:
        'Conectada mas SEM aparelho pareado (JID vazio): nenhuma mensagem sera recebida. ' +
        'Faca logout no WuzAPI e pareie de novo lendo o QR.',
    };
  }
  if (!logada) {
    return { estado: 'nao_autenticada', ok: false, mensagem: 'Sessao nao autenticada. Leia o QR.' };
  }

  return { estado: 'ok', ok: true, mensagem: 'Sessao pareada e recebendo eventos.', jid };
}
