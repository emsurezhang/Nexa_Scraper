/**
 * YouTube 插件
 * 功能：
 *   1. 抓取频道 Videos Tab 的视频列表
 *   2. 抓取单个视频页的详情
 *   3. 通过 yt-dlp 下载音频 + whisper 生成字幕
 */

import * as cheerio from 'cheerio';
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
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface YtVideoRenderer {
  videoId?: string;
  title?: { runs?: { text: string }[]; simpleText?: string };
  publishedTimeText?: { simpleText?: string };
  viewCountText?: { simpleText?: string; runs?: { text: string }[] };
  lengthText?: { simpleText?: string };
  ownerText?: { runs?: { text: string }[] };
  descriptionSnippet?: { runs?: { text: string }[] };
  thumbnail?: { thumbnails?: { url: string; width: number; height: number }[] };
}

interface YtRichItem {
  richItemRenderer?: { content?: { videoRenderer?: YtVideoRenderer } };
}

interface YtTab {
  tabRenderer?: {
    title?: string;
    selected?: boolean;
    content?: {
      richGridRenderer?: { contents?: YtRichItem[] };
      sectionListRenderer?: {
        contents?: {
          itemSectionRenderer?: {
            contents?: { gridRenderer?: { items?: { gridVideoRenderer?: YtVideoRenderer }[] } }[];
          };
        }[];
      };
    };
  };
}

interface YtStreamingFormat {
  itag: number;
  url?: string;
  signatureCipher?: string;
  mimeType: string;
  bitrate: number;
  contentLength?: string;
  approxDurationMs?: string;
  audioQuality?: string;
  audioSampleRate?: string;
}

interface YtVideoDetails {
  videoId?: string;
  title?: string;
  shortDescription?: string;
  author?: string;
  channelId?: string;
  lengthSeconds?: string;
  viewCount?: string;
  keywords?: string[];
  isLiveContent?: boolean;
  thumbnail?: { thumbnails?: { url: string }[] };
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

  /* ---- URL matching ------------------------------------------------ */

  matchUrl(url: string): number | null {
    try {
      const { hostname } = new URL(url);
      if (/^(www\.|m\.)?youtube\.com$/.test(hostname)) {
        return 3;
      }
      return null;
    } catch {
      return null;
    }
  }

  /* ---- Page type detection ----------------------------------------- */

  pageType(url: string, _html: string): 'list' | 'single' | 'unknown' {
    try {
      const u = new URL(url);
      // 单视频页
      if (u.pathname === '/watch' && u.searchParams.has('v')) {
        return 'single';
      }
      // 频道 videos tab  /@handle/videos  /channel/UC.../videos  /c/xxx/videos
      if (/\/(videos|streams|shorts)\/?$/i.test(u.pathname)) {
        return 'list';
      }
      // 频道主页（默认当 list，YouTube 频道首页也会展示视频）
      if (/^\/@[^/]+\/?$/.test(u.pathname) || /^\/channel\/[^/]+\/?$/.test(u.pathname)) {
        return 'list';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /* ---- Wait for content -------------------------------------------- */

  async waitForContent(page: Page): Promise<void> {
    const url = page.url();
    const type = this.pageType(url, '');

    if (type === 'list') {
      // 等待视频网格渲染
      try {
        await page.waitForSelector(
          'ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer',
          { timeout: 15_000 },
        );
      } catch {
        // 可能页面结构变了，继续
      }
      // 让懒加载多渲染一些
      await this.autoScroll(page, 3);
    } else {
      // watch 页等待播放器 + 描述区
      try {
        await page.waitForSelector('#above-the-fold, #info-contents, ytd-watch-metadata', {
          timeout: 15_000,
        });
      } catch {
        // 继续
      }
      // YouTube watch 页持续加载广告/推荐，不等 networkidle
      await page.waitForTimeout(2000);
    }
  }

  /* ---- Extract list ------------------------------------------------ */

  async extractList(html: string, url: string): Promise<ListItem[]> {
    // 优先从 ytInitialData 提取（更可靠）
    const initialData = this.extractYtInitialData(html);
    if (initialData) {
      const items = this.parseVideoListFromInitialData(initialData);
      if (items.length > 0) return items;
    }

    // 回退：从 DOM 提取
    return this.parseVideoListFromDom(html, url);
  }

  /* ---- Extract single ---------------------------------------------- */

  async extractSingle(html: string, url: string): Promise<SingleItem> {
    const videoId = this.extractVideoId(url) ?? `yt_${Date.now()}`;

    // 从 ytInitialPlayerResponse / ytInitialData 提取
    const playerResponse = this.extractYtPlayerResponse(html);
    const initialData = this.extractYtInitialData(html);

    const videoDetails = playerResponse?.videoDetails as YtVideoDetails | undefined;

    const title =
      videoDetails?.title ??
      this.ogMeta(html, 'og:title') ??
      'Untitled';

    const description =
      videoDetails?.shortDescription ??
      this.ogMeta(html, 'og:description') ??
      '';

    const author =
      videoDetails?.author ??
      this.ogMeta(html, 'og:site_name') ??
      '';

    const publishedAt = this.extractPublishDate(initialData);

    const durationSec = videoDetails?.lengthSeconds
      ? parseInt(videoDetails.lengthSeconds, 10)
      : undefined;

    const viewCount = videoDetails?.viewCount
      ? parseInt(videoDetails.viewCount, 10)
      : undefined;

    const stats: Record<string, number> = {};
    if (viewCount !== undefined && !isNaN(viewCount)) stats.views = viewCount;
    if (durationSec !== undefined && !isNaN(durationSec)) stats.durationSec = durationSec;

    // 从 initialData 中提取 likes
    const likes = this.extractLikes(initialData);
    if (likes !== undefined) stats.likes = likes;

    const tags = videoDetails?.keywords?.slice(0, 30) ?? [];

    return {
      id: videoId,
      url,
      title,
      content: description,
      publishedAt,
      author,
      tags,
      stats,
      raw: {
        channelId: videoDetails?.channelId,
        isLive: videoDetails?.isLiveContent,
        thumbnail: videoDetails?.thumbnail?.thumbnails?.at(-1)?.url,
      },
    };
  }

  /* ---- Login state ------------------------------------------------- */

  async checkLoginState(page: Page): Promise<LoginState> {
    // 已登录用户会有头像按钮；未登录则显示 "Sign in" 按钮
    const signInBtn = await page.$('a[href*="accounts.google.com"], tp-yt-paper-button#sign-in');
    if (signInBtn) return 'logged-out';

    const avatar = await page.$('#avatar-btn, button#avatar-btn');
    if (avatar) return 'logged-in';

    return 'unknown';
  }

  /* ---- Media fetch (legacy — returns stream URL) ------------------- */

  async fetchMedia(page: Page, _url: string): Promise<MediaInfo> {
    const html = await page.content();
    const pr = this.extractYtPlayerResponse(html);
    if (pr) return this.pickBestAudio(pr);
    throw new Error('Failed to extract audio stream info');
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
        .map(line => line.trim());
      writeFileSync(transcriptPath, textLines.join(''), 'utf-8');
      logger.info(`Transcript saved: ${transcriptPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Whisper transcription failed: ${msg}`);
    }

    return { audioPath, subtitlePath, transcriptPath, durationSec };
  }

  /* ---- Whisper transcription --------------------------------------- */

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

  /* ================================================================== */
  /*  Private helpers                                                    */
  /* ================================================================== */

  /** 自动向下滚动，让 YouTube 懒加载更多视频 */
  private async autoScroll(page: Page, times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      await page.evaluate('window.scrollBy(0, window.innerHeight)');
      await page.waitForTimeout(1200);
    }
  }

  /* ---- ytInitialData / ytInitialPlayerResponse 提取 ---------------- */

  private extractYtInitialData(html: string): Record<string, unknown> | null {
    return this.extractJsonVar(html, 'ytInitialData');
  }

  private extractYtPlayerResponse(html: string): Record<string, unknown> | null {
    return this.extractJsonVar(html, 'ytInitialPlayerResponse');
  }

  /**
   * 从 HTML 中提取 `var xxx = {...};` 形式的 JSON 变量。
   * YouTube 页面会内联大量数据供客户端 hydration。
   */
  private extractJsonVar(html: string, varName: string): Record<string, unknown> | null {
    // 匹配形如 var ytInitialData = { ... };
    const patterns = [
      new RegExp(`var\\s+${varName}\\s*=\\s*`),
      new RegExp(`window\\["${varName}"\\]\\s*=\\s*`),
      new RegExp(`${varName}\\s*=\\s*`),
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (!match) continue;

      const startIdx = match.index + match[0].length;
      // 使用括号匹配法定位 JSON 结束位置
      const json = this.extractBalancedJson(html, startIdx);
      if (json) {
        try {
          return JSON.parse(json);
        } catch {
          // 继续尝试下一个 pattern
        }
      }
    }
    return null;
  }

  /** 从 startIdx 开始提取一个完整的 { ... } JSON 块 */
  private extractBalancedJson(html: string, startIdx: number): string | null {
    if (html[startIdx] !== '{') return null;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = startIdx; i < html.length; i++) {
      const ch = html[i];

      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return html.slice(startIdx, i + 1);
        }
      }
    }
    return null;
  }

  /* ---- 从 ytInitialData 解析视频列表 ------------------------------ */

  private parseVideoListFromInitialData(data: Record<string, unknown>): ListItem[] {
    const items: ListItem[] = [];

    // 频道 Videos tab 路径：
    // data.contents.twoColumnBrowseResultsRenderer.tabs[N].tabRenderer.content
    //   .richGridRenderer.contents[].richItemRenderer.content.videoRenderer
    const tabs = this.dig(data, 'contents', 'twoColumnBrowseResultsRenderer', 'tabs') as
      | YtTab[]
      | undefined;

    if (Array.isArray(tabs)) {
      for (const tab of tabs) {
        const gridContents = tab.tabRenderer?.content?.richGridRenderer?.contents;
        if (gridContents) {
          for (const item of gridContents) {
            const vr = item.richItemRenderer?.content?.videoRenderer;
            if (vr) {
              const parsed = this.videoRendererToListItem(vr);
              if (parsed) items.push(parsed);
            }
          }
        }

        // 兼容旧版 grid 布局
        const sectionContents = tab.tabRenderer?.content?.sectionListRenderer?.contents;
        if (sectionContents) {
          for (const section of sectionContents) {
            const isr = (section as Record<string, unknown>).itemSectionRenderer as
              | { contents?: { gridRenderer?: { items?: { gridVideoRenderer?: YtVideoRenderer }[] } }[] }
              | undefined;
            if (isr?.contents) {
              for (const c of isr.contents) {
                const gridItems = c.gridRenderer?.items;
                if (gridItems) {
                  for (const gi of gridItems) {
                    if (gi.gridVideoRenderer) {
                      const parsed = this.videoRendererToListItem(gi.gridVideoRenderer);
                      if (parsed) items.push(parsed);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 搜索更深层的嵌套（YouTube 经常改结构）
    if (items.length === 0) {
      this.findVideoRenderers(data, items, 0);
    }

    return items;
  }

  /** 递归搜索 videoRenderer / gridVideoRenderer 节点 */
  private findVideoRenderers(
    obj: unknown,
    results: ListItem[],
    depth: number,
  ): void {
    if (depth > 15 || !obj || typeof obj !== 'object') return;

    const record = obj as Record<string, unknown>;

    if (record.videoRenderer) {
      const parsed = this.videoRendererToListItem(record.videoRenderer as YtVideoRenderer);
      if (parsed) results.push(parsed);
      return; // 不再递归进 videoRenderer 内部
    }
    if (record.gridVideoRenderer) {
      const parsed = this.videoRendererToListItem(record.gridVideoRenderer as YtVideoRenderer);
      if (parsed) results.push(parsed);
      return;
    }

    for (const val of Object.values(record)) {
      if (Array.isArray(val)) {
        for (const item of val) {
          this.findVideoRenderers(item, results, depth + 1);
        }
      } else if (val && typeof val === 'object') {
        this.findVideoRenderers(val, results, depth + 1);
      }
    }
  }

  private videoRendererToListItem(vr: YtVideoRenderer): ListItem | null {
    const videoId = vr.videoId;
    if (!videoId) return null;

    const title =
      vr.title?.runs?.map((r) => r.text).join('') ?? vr.title?.simpleText ?? '';

    const viewCountText =
      vr.viewCountText?.simpleText ??
      vr.viewCountText?.runs?.map((r) => r.text).join('') ??
      '';

    return {
      id: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title,
      meta: {
        publishedTime: vr.publishedTimeText?.simpleText,
        viewCount: viewCountText,
        duration: vr.lengthText?.simpleText,
        thumbnail: vr.thumbnail?.thumbnails?.at(-1)?.url,
      },
    };
  }

  /* ---- DOM 回退解析 ------------------------------------------------ */

  private parseVideoListFromDom(html: string, _url: string): ListItem[] {
    const $ = cheerio.load(html);
    const items: ListItem[] = [];

    // ytd-rich-item-renderer / ytd-grid-video-renderer / ytd-video-renderer
    $('a#video-title-link, a#video-title').each((_i, el) => {
      const $el = $(el);
      const href = $el.attr('href') ?? '';
      const title = $el.text().trim() || $el.attr('title') || '';
      const videoId = this.extractVideoIdFromPath(href);

      if (videoId) {
        items.push({
          id: videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          title,
        });
      }
    });

    return items;
  }

  /* ---- 音频流选择 -------------------------------------------------- */

  private pickBestAudio(playerResponse: Record<string, unknown>): MediaInfo {
    const streamingData = playerResponse.streamingData as
      | { adaptiveFormats?: YtStreamingFormat[]; formats?: YtStreamingFormat[] }
      | undefined;

    if (!streamingData) {
      throw new Error('No streamingData in player response');
    }

    // 从 adaptiveFormats 中筛选纯音频流
    const audioFormats = (streamingData.adaptiveFormats ?? []).filter(
      (f) => f.mimeType.startsWith('audio/'),
    );

    if (audioFormats.length === 0) {
      // 回退到 formats（混合流）
      const mixed = streamingData.formats?.[0];
      if (mixed?.url) {
        const durMs = mixed.approxDurationMs ? parseInt(mixed.approxDurationMs, 10) : undefined;
        return {
          audioUrl: mixed.url,
          format: mixed.mimeType,
          durationSec: durMs ? Math.round(durMs / 1000) : undefined,
        };
      }
      throw new Error('No audio streams found');
    }

    // 选择最高码率的音频流
    audioFormats.sort((a, b) => b.bitrate - a.bitrate);
    const best = audioFormats[0];

    if (!best.url) {
      throw new Error('Audio stream URL requires signature deciphering (not supported)');
    }

    const durMs = best.approxDurationMs ? parseInt(best.approxDurationMs, 10) : undefined;

    return {
      audioUrl: best.url,
      format: best.mimeType,
      durationSec: durMs ? Math.round(durMs / 1000) : undefined,
    };
  }

  /* ---- 工具方法 ---------------------------------------------------- */

  private extractVideoId(url: string): string | null {
    try {
      const u = new URL(url);
      return u.searchParams.get('v');
    } catch {
      return null;
    }
  }

  private extractVideoIdFromPath(href: string): string | null {
    const match = /[?&]v=([a-zA-Z0-9_-]{11})/.exec(href);
    return match?.[1] ?? null;
  }

  private ogMeta(html: string, property: string): string | undefined {
    const $ = cheerio.load(html);
    return $(`meta[property="${property}"]`).attr('content') || undefined;
  }

  private extractPublishDate(data: Record<string, unknown> | null): string | undefined {
    if (!data) return undefined;
    // data.contents.twoColumnWatchNextResults.results.results.contents[0]
    //   .videoPrimaryInfoRenderer.dateText.simpleText
    const dateText = this.deepFind(data, 'dateText');
    if (dateText && typeof dateText === 'object') {
      const st = (dateText as { simpleText?: string }).simpleText;
      if (st) return st;
    }
    // 或 publishDate 字段
    const publishDate = this.deepFind(data, 'publishDate');
    if (typeof publishDate === 'string') return publishDate;
    return undefined;
  }

  private extractLikes(data: Record<string, unknown> | null): number | undefined {
    if (!data) return undefined;
    // 通常嵌套在 topLevelButtons → toggleButtonRenderer → defaultText
    // likes 数据嵌套较深且 YouTube 经常改结构，暂不提取
    return undefined;
  }

  /** 安全地沿着 key 路径取值 */
  private dig(obj: unknown, ...keys: string[]): unknown {
    let current: unknown = obj;
    for (const key of keys) {
      if (current == null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  /** 在嵌套对象中查找第一个匹配 key 的值（BFS，深度限制） */
  private deepFind(obj: unknown, targetKey: string, maxDepth = 10): unknown {
    const queue: { val: unknown; depth: number }[] = [{ val: obj, depth: 0 }];

    while (queue.length > 0) {
      const { val, depth } = queue.shift()!;
      if (depth > maxDepth || !val || typeof val !== 'object') continue;

      if (!Array.isArray(val)) {
        const record = val as Record<string, unknown>;
        if (targetKey in record) return record[targetKey];
        for (const v of Object.values(record)) {
          queue.push({ val: v, depth: depth + 1 });
        }
      } else {
        for (const item of val) {
          queue.push({ val: item, depth: depth + 1 });
        }
      }
    }
    return undefined;
  }
}
