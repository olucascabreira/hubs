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
  /** Duracao em segundos — o WhatsApp exibe isso na bolha. */
  segundos: number | null;
  /** 64 amplitudes 0-100: e o desenho da onda na nota de voz. */
  waveform: number[] | null;
}

const PCM_ARGS = [
  '-hide_banner',
  '-loglevel', 'error',
  '-i', 'pipe:0',
  '-vn',
  '-ac', '1',
  '-ar', '8000', // resolucao de sobra para 64 amostras
  '-f', 's16le',
  'pipe:1',
];

const AMOSTRAS_WAVEFORM = 64;
const TAXA_PCM = 8000;

/**
 * Duracao e desenho da onda.
 *
 * O WhatsApp nao deduz nada do arquivo: sem `Seconds` a bolha fica sem tempo,
 * e sem `Waveform` ela aparece reta. Os dois vem de uma passada em PCM.
 */
async function analisarAudio(
  input: Buffer,
): Promise<{ segundos: number | null; waveform: number[] | null }> {
  if (ffmpegAusente) return { segundos: null, waveform: null };

  try {
    const pcm = await executarFfmpeg(input, PCM_ARGS);
    const totalAmostras = Math.floor(pcm.length / 2);
    if (totalAmostras === 0) return { segundos: null, waveform: null };

    const segundos = Math.max(1, Math.round(totalAmostras / TAXA_PCM));

    // RMS por balde: representa energia percebida melhor que o pico.
    const porBalde = Math.floor(totalAmostras / AMOSTRAS_WAVEFORM) || 1;
    const rms: number[] = [];
    for (let b = 0; b < AMOSTRAS_WAVEFORM; b += 1) {
      const inicio = b * porBalde;
      let soma = 0;
      let n = 0;
      for (let i = inicio; i < inicio + porBalde && i < totalAmostras; i += 1) {
        const v = pcm.readInt16LE(i * 2) / 32768;
        soma += v * v;
        n += 1;
      }
      rms.push(n ? Math.sqrt(soma / n) : 0);
    }

    // Normaliza pelo pico: audio baixo continua desenhando onda visivel.
    const pico = Math.max(...rms, 1e-6);
    const waveform = rms.map((v) => Math.max(0, Math.min(100, Math.round((v / pico) * 100))));

    return { segundos, waveform };
  } catch (err) {
    logger.warn({ err }, 'nao foi possivel calcular duracao/onda do audio');
    return { segundos: null, waveform: null };
  }
}

export async function paraNotaDeVoz(
  input: Buffer,
  mimetypeOriginal: string,
): Promise<AudioConvertido> {
  // A analise vale para qualquer formato: mesmo audio ja em OGG precisa de
  // duracao e onda para a bolha ficar completa.
  const { segundos, waveform } = await analisarAudio(input);

  const semConversao: AudioConvertido = {
    buffer: input,
    mimetype: mimetypeOriginal,
    convertido: false,
    segundos,
    waveform,
  };

  if (jaEhNotaDeVoz(mimetypeOriginal)) {
    return { ...semConversao, mimetype: 'audio/ogg; codecs=opus' };
  }
  if (ffmpegAusente) return semConversao;

  try {
    const saida = await executarFfmpeg(input, OPUS_ARGS);
    if (!saida.length) throw new Error('ffmpeg devolveu saida vazia');
    return {
      buffer: saida,
      mimetype: 'audio/ogg; codecs=opus',
      convertido: true,
      segundos,
      waveform,
    };
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

function executarFfmpeg(input: Buffer, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

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
