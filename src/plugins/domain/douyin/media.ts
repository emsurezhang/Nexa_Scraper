/**
 * 抖音音频下载模块
 *
 * 使用 Playwright 打开视频页，通过网络拦截捕获 douyinvod 音频流 URL，
 * 然后用 axios 下载音频文件。
 *
 * 参考：tmp/subtitle.ts 中的 TikTokAudioDownloadService
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { stat } from 'fs/promises';
import { createLogger } from '../../../core/logger.js';
import { loadCookies } from '../../../core/capabilities/cookie-manager.js';
import config from '../../../core/config.js';

const logger = createLogger({ module: 'plugin:douyin:media' });

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface MediaDownloadResult {
  audioPath: string;
  subtitlePath: string | null;
  transcriptPath: string | null;
  durationSec: number;
}

/**
 * 下载抖音视频音频并通过 whisper 生成字幕。
 *
 * 流程：
 *   1. 启动 Playwright 浏览器，导航到视频页
 *   2. 拦截 douyinvod 音频请求，捕获 URL
 *   3. 用 axios 下载音频到 outputDir
 *   4. 用 whisper-cli 转录生成 SRT 字幕
 *   5. 从 SRT 提取纯文本 transcript
 */
export async function downloadMedia(
  url: string,
  outputDir: string,
): Promise<MediaDownloadResult> {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // 1. 通过 Playwright 网络拦截获取音频 URL 并下载
  const audioPath = resolve(outputDir, 'audio.m4a');
  await captureAndDownloadAudio(url, audioPath);

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
/*  Playwright 音频捕获                                                 */
/* ================================================================== */

async function captureAndDownloadAudio(
  pageUrl: string,
  audioPath: string,
): Promise<void> {
  let browser: Browser | null = null;

  try {
    logger.info('Launching browser to capture audio URL...');

    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: BROWSER_UA,
    });

    // 注入 Cookie
    const domain = extractDomain(pageUrl);
    if (domain) {
      const cookies = loadCookies(domain);
      if (cookies && cookies.length > 0) {
        await context.addCookies(cookies);
        logger.debug(`Injected ${cookies.length} cookies for ${domain}`);
      }
    }

    const page = await context.newPage();

    // 拦截音频请求
    let audioUrl: string | null = null;
    let capturedHeaders: Record<string, string> = {
      'user-agent': BROWSER_UA,
      referer: pageUrl,
    };

    let resolveCapture: (() => void) | null = null;
    const capturePromise = new Promise<void>(resolve => {
      resolveCapture = resolve;
    });

    page.on('response', async response => {
      const respUrl = response.url();
      // 匹配抖音 CDN 音频请求
      if (!respUrl.includes('douyinvod') || !respUrl.includes('audio')) {
        return;
      }

      const isFirstCapture = !audioUrl;
      audioUrl = respUrl;

      // 捕获原始请求头以便后续下载
      try {
        capturedHeaders = {
          ...capturedHeaders,
          ...(await response.request().allHeaders()),
        };
      } catch {
        // 忽略
      }

      if (isFirstCapture) {
        logger.info(`Captured audio URL: ${respUrl.slice(0, 120)}...`);
        resolveCapture?.();
      }
    });

    // 导航到页面
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    logger.debug('Page navigation complete (domcontentloaded)');

    // 等待网络空闲 + 额外时间让播放器加载
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(5000);

    // 如果还没捕获到，再等一会
    if (!audioUrl) {
      logger.debug('Audio URL not captured yet, waiting for delayed responses...');
      await Promise.race([
        capturePromise,
        page.waitForTimeout(10_000),
      ]);
    }

    // 获取 Cookie 用于下载
    let cookieHeader = '';
    if (audioUrl) {
      try {
        const ctxCookies = await context.cookies(audioUrl);
        if (ctxCookies.length > 0) {
          cookieHeader = ctxCookies.map(c => `${c.name}=${c.value}`).join('; ');
        }
      } catch {
        // 忽略
      }
    }

    await page.close();
    await context.close();

    if (!audioUrl) {
      throw new Error('No douyinvod audio URL captured from network responses');
    }

    // 用 axios 下载音频
    logger.info('Downloading captured audio...');

    const requestHeaders: Record<string, string> = {
      'user-agent': capturedHeaders['user-agent'] || BROWSER_UA,
      referer: capturedHeaders.referer || pageUrl,
    };
    if (capturedHeaders.accept) {
      requestHeaders.accept = capturedHeaders.accept;
    }
    if (cookieHeader) {
      requestHeaders.cookie = cookieHeader;
    }

    const response = await axios.get(audioUrl, {
      responseType: 'stream',
      headers: requestHeaders,
      timeout: 60_000,
      maxRedirects: 5,
    });

    logger.debug(`Download response: status=${response.status}`);
    await pipeline(response.data, createWriteStream(audioPath));

    // 处理 partial range：如果返回 206 且 range 不从 0 开始，用清理后的 URL 重试
    const contentRange = typeof response.headers['content-range'] === 'string'
      ? response.headers['content-range']
      : '';
    const isNonZeroPartialRange =
      response.status === 206 &&
      /^bytes\s+(?!0-)/i.test(contentRange);

    if (isNonZeroPartialRange) {
      logger.debug(`Detected partial-range response (${contentRange}), retrying with sanitized URL`);
      const fullUrl = sanitizeAudioUrl(audioUrl);
      if (fullUrl !== audioUrl) {
        const retryResponse = await axios.get(fullUrl, {
          responseType: 'stream',
          headers: requestHeaders,
          timeout: 60_000,
          maxRedirects: 5,
        });
        await pipeline(retryResponse.data, createWriteStream(audioPath));
      }
    }

    // 验证文件有效性
    const fileStat = await stat(audioPath).catch(() => null);
    if (!fileStat || fileStat.size < 16 * 1024) {
      throw new Error(
        `Downloaded audio file is too small: ${fileStat?.size ?? 0} bytes`,
      );
    }

    logger.info(`Audio saved: ${audioPath} (${fileStat.size} bytes)`);
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

/** 删除 URL 中的 range 参数以获取完整音频 */
function sanitizeAudioUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of ['range', 'byterange', 'byte_range', 'start', 'end']) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
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

  // 抖音视频以中文为主，先自动检测，回退 zh
  let language = config.media.whisperLanguage ?? 'auto';
  if (language === 'auto') {
    const detected = await detectLanguage(audioPath, modelPath);
    if (detected) {
      language = detected;
      logger.info(`Auto-detected language: ${language}`);
    } else {
      language = 'zh';
      logger.warn('Language detection failed, falling back to "zh"');
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
