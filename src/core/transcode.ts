import { spawn } from 'node:child_process';
import { logger } from '../logger';
import { baseMime } from './media';

/**
 * Converte audio para OGG/Opus, formato exigido pela nota de voz do WhatsApp.
 *
 * Sem isto, um mp3 vindo do Chatwoot so pode ser enviado como arquivo de audio:
 * o destinatario ve o nome do arquivo e precisa baixar, em vez da bolha com
 * forma de onda que toca inline.
 *
 * Depende do ffmpeg na imagem. Se faltar ou falhar, o chamador segue com o
 * audio original — degradar e melhor do que nao entregar.
 */

const OPUS_ARGS = [
  '-hide_banner',
  '-loglevel', 'error',
  '-i', 'pipe:0',
  '-vn', // descarta capa embutida em mp3
  '-map_metadata', '-1',
  '-c:a', 'libopus',
  '-b:a', '32k', // suficiente para voz; mantem a mensagem leve
  '-ar', '48000',
  '-ac', '1',
  '-application', 'voip',
  '-f', 'ogg',
  'pipe:1',
];

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

let ffmpegAusente = false;

export function jaEhNotaDeVoz(mimetype: string): boolean {
  const mime = baseMime(mimetype);
  return mime === 'audio/ogg' || mime === 'audio/opus';
}

export interface AudioConvertido {
  buffer: Buffer;
  mimetype: string;
  convertido: boolean;
}

export async function paraNotaDeVoz(
  input: Buffer,
  mimetypeOriginal: string,
): Promise<AudioConvertido> {
  const semConversao: AudioConvertido = {
    buffer: input,
    mimetype: mimetypeOriginal,
    convertido: false,
  };

  if (jaEhNotaDeVoz(mimetypeOriginal)) {
    return { buffer: input, mimetype: 'audio/ogg; codecs=opus', convertido: false };
  }
  if (ffmpegAusente) return semConversao;

  try {
    const saida = await executarFfmpeg(input);
    if (!saida.length) throw new Error('ffmpeg devolveu saida vazia');
    return { buffer: saida, mimetype: 'audio/ogg; codecs=opus', convertido: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ENOENT')) {
      // Avisa uma vez so; nas proximas nem tenta.
      ffmpegAusente = true;
      logger.warn('ffmpeg indisponivel; audios serao enviados como arquivo, nao como nota de voz');
    } else {
      logger.warn({ err, mimetypeOriginal }, 'falha ao converter audio; enviando o original');
    }
    return semConversao;
  }
}

function executarFfmpeg(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', OPUS_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });

    const partes: Buffer[] = [];
    let bytes = 0;
    let erroStderr = '';
    let encerrado = false;

    const encerrar = (err: Error | null, out?: Buffer) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(timer);
      if (err) {
        proc.kill('SIGKILL');
        reject(err);
      } else {
        resolve(out!);
      }
    };

    const timer = setTimeout(
      () => encerrar(new Error(`ffmpeg excedeu ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );

    proc.stdout.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_OUTPUT_BYTES) return encerrar(new Error('saida do ffmpeg acima do limite'));
      partes.push(c);
    });
    proc.stderr.on('data', (c: Buffer) => {
      erroStderr += c.toString();
    });

    proc.on('error', (err) => encerrar(err));
    proc.on('close', (code) => {
      if (code === 0) encerrar(null, Buffer.concat(partes));
      else encerrar(new Error(`ffmpeg saiu com codigo ${code}: ${erroStderr.slice(0, 300)}`));
    });

    // EPIPE acontece quando o ffmpeg rejeita a entrada e fecha stdin antes da
    // escrita terminar; o codigo de saida ja descreve o erro.
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(input);
  });
}
