/**
 * YouTube 插件
 * 功能：
 *   1. 抓取频道 Videos Tab 的视频列表
 *   2. 抓取单个视频页的详情
 *   3. 通过 yt-dlp 下载音频 + whisper 生成字幕
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Page } from 'playwright';
import YTDlpWrapModule from 'yt-dlp-wrap';
import type {
  NexaPlugin,
  PluginMeta,
  ListItem,
  SingleItem,
  MediaInfo,
  LoginState,
} from '../../../core/plugin-contract.js';
import { createLogger } from '../../../core/logger.js';
import config from '../../../core/config.js';
import { matchUrl, pageType } from './url-matcher.js';
import { waitForContent } from './waiting-strategy.js';
import { checkLoginState } from './login-state.js';
import { extractList, extractSingle, extractMediaInfo } from './extractor.js';

const logger = createLogger({ module: 'plugin:youtube' });

// yt-dlp-wrap exports CJS default
const YTDlpWrap = (YTDlpWrapModule as any).default || YTDlpWrapModule;

export interface MediaDownloadResult {
  audioPath: string;
  subtitlePath: string | null;
  transcriptPath: string | null;
  durationSec: number;
}

/* ------------------------------------------------------------------ */
/*  Plugin                                                             */
/* ------------------------------------------------------------------ */

export default class YouTubePlugin implements NexaPlugin {
  meta: PluginMeta = {
    name: 'youtube',
    version: '1.0.0',
    domains: ['youtube.com', 'www.youtube.com', 'm.youtube.com'],
    priority: 3,
    author: 'Nexa Team',
    requiresLogin: false,
  };

  matchUrl(url: string): number | null {
    return matchUrl(url);
  }

  pageType(url: string, _html: string): 'list' | 'single' | 'unknown' {
    return pageType(url);
  }

  async waitForContent(page: Page): Promise<void> {
    return waitForContent(page);
  }

  async extractList(html: string, url: string): Promise<ListItem[]> {
    return extractList(html, url);
  }

  async extractSingle(html: string, url: string): Promise<SingleItem> {
    return extractSingle(html, url);
  }

  async checkLoginState(page: Page): Promise<LoginState> {
    return checkLoginState(page);
  }

  /* ---- Media fetch (legacy — returns stream URL) ------------------- */

  async fetchMedia(page: Page, _url: string): Promise<MediaInfo> {
    const html = await page.content();
    return extractMediaInfo(html);
  }

  /* ---- Media download (yt-dlp + whisper) --------------------------- */

  async downloadMedia(url: string, outputDir: string): Promise<MediaDownloadResult> {
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    // 1. 用 yt-dlp 下载最佳音频
    logger.info('Downloading audio via yt-dlp...');
    const audioPath = resolve(outputDir, 'audio.mp3');
    const ytDlp = new YTDlpWrap();

    await ytDlp.execPromise([
      url,
      '-x',                        // 仅提取音频
      '--audio-format', 'mp3',
      '--audio-quality', '0',       // 最佳质量
      '-o', audioPath,
      '--no-playlist',
      '--no-warnings',
    ]);

    if (!existsSync(audioPath)) {
      throw new Error('yt-dlp did not produce audio file');
    }
    logger.info(`Audio saved: ${audioPath}`);

    // 获取时长
    const durationSec = await this.getAudioDuration(audioPath);

    // 2. 用 whisper 生成字幕
    let subtitlePath: string | null = null;
    let transcriptPath: string | null = null;
    try {
      subtitlePath = await this.transcribeWithWhisper(audioPath, outputDir);
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
  /*  Media helpers (yt-dlp + whisper)                                   */
  /* ================================================================== */

  private async transcribeWithWhisper(
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

    // 确定语言：配置指定 or 自动检测
    let language = config.media.whisperLanguage ?? 'auto';
    if (language === 'auto') {
      const detected = await this.detectLanguage(audioPath, modelPath);
      if (detected) {
        language = detected;
        logger.info(`Auto-detected language: ${language}`);
      } else {
        language = 'en';
        logger.warn('Language detection failed, falling back to "en"');
      }
    }

    const outputPrefix = resolve(outputDir, 'subtitles');

    await this.spawnAsync('whisper-cli', [
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
   * 用 whisper 对音频前 30 秒做语言检测。
   * whisper-cli --detect-language 会在 stderr 输出:
   *   whisper_full_with_state: auto-detected language: zh (p = 0.95)
   */
  private detectLanguage(audioPath: string, modelPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn('whisper-cli', [
        '-m', modelPath,
        '-f', audioPath,
        '-dl',          // --detect-language：只检测语言，不转录
      ]);

      let output = '';
      child.stdout.on('data', (d) => { output += d.toString(); });
      child.stderr.on('data', (d) => { output += d.toString(); });

      child.on('close', () => {
        // 匹配 "auto-detected language: xx" 或 "language: xx"
        const match = /auto-detected language:\s*(\w+)/i.exec(output);
        resolve(match?.[1] ?? null);
      });
      child.on('error', () => resolve(null));
    });
  }

  private async getAudioDuration(audioPath: string): Promise<number> {
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

  private spawnAsync(cmd: string, args: string[]): Promise<void> {
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
}
