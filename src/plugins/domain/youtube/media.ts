/**
 * YouTube 媒体下载模块
 *
 * 1. 使用 yt-dlp 下载最佳音频
 * 2. 用 ffmpeg 转码为 16kHz mono WAV（whisper 支持）
 * 3. 用 whisper 生成字幕和 transcript
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { stat } from 'fs/promises';
import { createLogger } from '../../../core/logger.js';
import config from '../../../core/config.js';
import { exportCookiesToNetscape, hasCookies } from '../../../core/capabilities/cookie-manager.js';

const logger = createLogger({ module: 'plugin:youtube:media' });

export interface MediaDownloadResult {
  audioPath: string;
  subtitlePath: string | null;
  transcriptPath: string | null;
  durationSec: number;
}

/**
 * 下载 YouTube 视频音频并通过 whisper 生成字幕。
 *
 * 流程：
 *   1. 用 yt-dlp 下载最佳音频到 outputDir
 *   2. 用 ffmpeg 转换为 16kHz mono WAV
 *   3. 用 whisper-cli 转录生成 SRT 字幕
 *   4. 从 SRT 提取纯文本 transcript
 */
export async function downloadMedia(
  url: string,
  outputDir: string,
): Promise<MediaDownloadResult> {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // 1. 用 yt-dlp 下载音频
  const audioPath = resolve(outputDir, 'audio.m4a');
  await downloadAudioWithYtDlp(url, audioPath);

  // 2. 转换为 whisper 要求的 16kHz mono WAV
  const wavPath = resolve(outputDir, 'audio.wav');
  await convertToWav(audioPath, wavPath);

  // 3. 获取音频时长
  const durationSec = await getAudioDuration(audioPath);

  // 4. 用 whisper 生成字幕
  let subtitlePath: string | null = null;
  let transcriptPath: string | null = null;
  try {
    subtitlePath = await transcribeWithWhisper(wavPath, outputDir);
    logger.info(`Subtitles saved: ${subtitlePath}`);

    // 从 SRT 提取纯文本
    transcriptPath = resolve(outputDir, 'transcript.txt');
    const srtContent = readFileSync(subtitlePath, 'utf-8');
    const textLines = srtContent
      .split('\n')
      .filter(line => line.trim() && !/^\d+$/.test(line.trim()) && !/-->/.test(line))
      .map(line => line.trim().replace(/^"+|"+$/g, ''));
    writeFileSync(transcriptPath, textLines.join(''), 'utf-8');
    logger.info(`Transcript saved: ${transcriptPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Whisper transcription failed: ${msg}`);
  }

  return { audioPath, subtitlePath, transcriptPath, durationSec };
}

/* ================================================================== */
/*  yt-dlp 音频下载                                                     */
/* ================================================================== */

async function downloadAudioWithYtDlp(url: string, outputPath: string): Promise<void> {
  logger.info('Downloading audio with yt-dlp...');

  // 准备 cookies（如果有）
  const cookieFile = resolve(outputPath, '../cookies.txt');
  const hasCookie = hasCookies('youtube.com');
  let cookieArgs: string[] = [];
  if (hasCookie && exportCookiesToNetscape('youtube.com', cookieFile)) {
    cookieArgs = ['--cookies', cookieFile];
    logger.info('Using exported Netscape cookies for youtube.com');
  }

  // 按优先级依次尝试的格式选择器
  const formatCandidates = [
    'bestaudio[ext=m4a]',
    'bestaudio[ext=webm]',
    'bestaudio',
    'bestaudio/best',
    'best',
  ];

  let lastError: Error | null = null;

  for (const fmt of formatCandidates) {
    try {
      logger.info(`Trying format selector: ${fmt}`);
      await spawnAsync('yt-dlp', [
        '-f', fmt,
        '--no-playlist',
        ...cookieArgs,
        '-o', outputPath,
        url,
      ]);

      const fileStat = await stat(outputPath).catch(() => null);
      if (!fileStat || fileStat.size < 16 * 1024) {
        throw new Error(`Downloaded file too small: ${fileStat?.size ?? 0} bytes`);
      }

      logger.info(`Audio saved: ${outputPath} (${fileStat.size} bytes) via format "${fmt}"`);
      return; // 成功则直接返回
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Format "${fmt}" failed: ${msg}`);
      lastError = err instanceof Error ? err : new Error(msg);

      // 只有"格式不可用"类错误才继续尝试下一个，其他错误（网络、权限等）直接抛出
      const isFormatError =
        /Requested format is not available/i.test(msg) ||
        /No video formats found/i.test(msg) ||
        /not available/i.test(msg);

      if (!isFormatError) {
        throw lastError;
      }
    }
  }

  // 所有候选格式都失败，尝试从 JSON 元数据中动态获取第一个可用格式
  logger.warn('All preset formats failed, probing available formats via --dump-json...');
  const fallbackFmt = await probeFirstAudioFormat(url, cookieArgs);
  if (!fallbackFmt) {
    throw lastError ?? new Error('No available audio format found for this video');
  }

  logger.info(`Probed fallback format: ${fallbackFmt}`);
  await spawnAsync('yt-dlp', [
    '-f', fallbackFmt,
    '--no-playlist',
    ...cookieArgs,
    '-o', outputPath,
    url,
  ]);

  const fileStat = await stat(outputPath).catch(() => null);
  if (!fileStat || fileStat.size < 16 * 1024) {
    throw new Error(`Downloaded file too small after fallback: ${fileStat?.size ?? 0} bytes`);
  }
  logger.info(`Audio saved (fallback): ${outputPath} (${fileStat.size} bytes)`);
}

/**
 * 通过 --dump-json 获取视频元数据，返回第一个 audio-only 格式的 format_id。
 * 相比解析 --list-formats 的文本输出，JSON 更稳定可靠。
 */
async function probeFirstAudioFormat(url: string, cookieArgs: string[] = []): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('yt-dlp', ['--dump-json', '--no-playlist', ...cookieArgs, url]);
    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', () => {}); // 静默 stderr
    child.on('close', () => {
      try {
        const meta = JSON.parse(output);
        const formats: Array<{ format_id: string; vcodec?: string; acodec?: string }> =
          meta.formats ?? [];

        // 优先选 audio-only（vcodec=none），次选有 acodec 的
        const audioOnly = formats.find(
          (f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none',
        );
        const withAudio = formats.find(
          (f) => f.acodec && f.acodec !== 'none',
        );

        resolve(audioOnly?.format_id ?? withAudio?.format_id ?? null);
      } catch {
        resolve(null);
      }
    });
    child.on('error', () => resolve(null));
  });
}

/* ================================================================== */
/*  ffmpeg 转换                                                         */
/* ================================================================== */

/** 将 m4a/mp4 等格式转换为 whisper-cli 要求的 16kHz mono WAV */
async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  logger.info('Converting audio to 16kHz mono WAV for whisper...');
  await spawnAsync('ffmpeg', [
    '-i', inputPath,
    '-ar', '16000',     // 16kHz 采样率
    '-ac', '1',          // 单声道
    '-c:a', 'pcm_s16le', // 16-bit PCM
    '-y',                // 覆盖输出
    outputPath,
  ]);

  if (!existsSync(outputPath)) {
    throw new Error('ffmpeg did not produce WAV file');
  }
  logger.info(`WAV converted: ${outputPath}`);
}

/* ================================================================== */
/*  Whisper 转录                                                        */
/* ================================================================== */

async function transcribeWithWhisper(
  audioPath: string,
  outputDir: string,
): Promise<string> {
  const model = config.media.whisperModel;
  const modelDir = config.media.whisperModelDir;
  const modelPath = resolve(modelDir, `ggml-${model}.bin`);

  if (!existsSync(modelPath)) {
    throw new Error(
      `Whisper model not found: ${modelPath}. Run: brew install whisper-cpp && download model`,
    );
  }

  // YouTube 视频以英文为主，先自动检测，回退 en
  let language = config.media.whisperLanguage ?? 'auto';
  if (language === 'auto') {
    const detected = await detectLanguage(audioPath, modelPath);
    if (detected) {
      language = detected;
      logger.info(`Auto-detected language: ${language}`);
    } else {
      language = 'en';
      logger.warn('Language detection failed, falling back to "en"');
    }
  }

  const outputPrefix = resolve(outputDir, 'subtitles');

  await spawnAsync('whisper-cli', [
    '-m', modelPath,
    '-f', audioPath,
    '-l', language,
    '-osrt',
    '-of', outputPrefix,
  ]);

  const srtPath = `${outputPrefix}.srt`;
  if (!existsSync(srtPath)) {
    throw new Error('whisper did not generate SRT file');
  }
  return srtPath;
}

/**
 * 用 whisper 对音频做语言检测。
 */
function detectLanguage(audioPath: string, modelPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('whisper-cli', [
      '-m', modelPath,
      '-f', audioPath,
      '-dl',
    ]);

    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });

    child.on('close', () => {
      const match = /auto-detected language:\s*(\w+)/i.exec(output);
      resolve(match?.[1] ?? null);
    });
    child.on('error', () => resolve(null));
  });
}

function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ]);
    let out = '';
    ffprobe.stdout.on('data', (d) => { out += d.toString(); });
    ffprobe.on('close', () => {
      const sec = parseFloat(out.trim());
      resolve(isNaN(sec) ? 0 : Math.round(sec));
    });
    ffprobe.on('error', () => resolve(0));
  });
}

function spawnAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr}`));
    });
    child.on('error', reject);
  });
}
