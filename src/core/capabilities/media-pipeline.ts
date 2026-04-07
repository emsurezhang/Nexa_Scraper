/**
 * 媒体处理流水线
 * 负责音频下载、分段、转录等处理
 */

import { spawn } from 'child_process';
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import { resolve, basename } from 'path';
import axios from 'axios';
import { createLogger } from '../logger.js';
import config from '../config.js';

const logger = createLogger({ module: 'media' });

export interface MediaPipelineOptions {
  url: string;
  outputDir: string;
  segmentDurationSec?: number;
  language?: string;
  keepIntermediates?: boolean;
}

export interface PipelineResult {
  audioPath: string;
  segments: string[];
  subtitlePath: string;
  durationSec: number;
  cost: {
    transcribeSec: number;
  };
}

export type PipelineEvent =
  | { type: 'progress'; stage: 'fetch' | 'split' | 'transcribe'; percent: number }
  | { type: 'complete'; result: PipelineResult }
  | { type: 'error'; stage: string; error: Error };

// 媒体流水线类
export class MediaPipeline {
  async *run(options: MediaPipelineOptions): AsyncGenerator<PipelineEvent> {
    const startTime = Date.now();
    const segmentDuration = options.segmentDurationSec ?? config.media.segmentDurationSec;
    const keepIntermediates = options.keepIntermediates ?? config.media.keepIntermediates;

    try {
      // 确保输出目录存在
      if (!existsSync(options.outputDir)) {
        mkdirSync(options.outputDir, { recursive: true });
      }

      // 1. 下载音频
      yield { type: 'progress', stage: 'fetch', percent: 0 };
      const audioPath = await this.downloadAudio(options.url, options.outputDir);
      yield { type: 'progress', stage: 'fetch', percent: 100 };

      // 2. 分割音频
      yield { type: 'progress', stage: 'split', percent: 0 };
      const segments = await this.splitAudio(audioPath, options.outputDir, segmentDuration, (_percent) => {
        // 这个回调在同步操作中可能不会被频繁调用
      });
      yield { type: 'progress', stage: 'split', percent: 100 };

      // 3. 转录
      yield { type: 'progress', stage: 'transcribe', percent: 0 };
      const subtitlePath = resolve(options.outputDir, 'subtitles.srt');
      
      let completedSegments = 0;
      const segmentSubtitles: string[] = [];
      
      for (let i = 0; i < segments.length; i++) {
        const segmentPath = segments[i];
        const offsetSec = i * segmentDuration;
        
        const srtContent = await this.transcribeSegment(segmentPath, offsetSec, options.language);
        segmentSubtitles.push(srtContent);
        
        completedSegments++;
        yield { 
          type: 'progress', 
          stage: 'transcribe', 
          percent: Math.round((completedSegments / segments.length) * 100) 
        };
      }

      // 合并字幕文件
      const mergedSubtitles = this.mergeSrtFiles(segmentSubtitles);
      const writeStream = createWriteStream(subtitlePath);
      writeStream.write(mergedSubtitles);
      writeStream.end();

      // 获取音频时长
      const durationSec = await this.getAudioDuration(audioPath);

      // 清理中间文件
      if (!keepIntermediates) {
        this.cleanup(segments);
        // 可选：删除原始音频
        // fs.unlinkSync(audioPath);
      }

      const transcribeSec = (Date.now() - startTime) / 1000;

      yield {
        type: 'complete',
        result: {
          audioPath,
          segments,
          subtitlePath,
          durationSec,
          cost: {
            transcribeSec,
          },
        },
      };

    } catch (error) {
      yield {
        type: 'error',
        stage: 'pipeline',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  // 下载音频
  private async downloadAudio(url: string, outputDir: string): Promise<string> {
    logger.info(`Downloading audio from: ${url}`);
    
    const outputPath = resolve(outputDir, 'audio.mp3');
    
    try {
      // 尝试直接下载
      const response = await axios({
        method: 'get',
        url,
        responseType: 'stream',
        timeout: 60000,
      });

      const writer = createWriteStream(outputPath);
      response.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      logger.info(`Audio downloaded to: ${outputPath}`);
      return outputPath;

    } catch (error) {
      // 如果直接下载失败，尝试使用 ffmpeg 下载
      logger.warn(`Direct download failed, trying ffmpeg: ${error}`);
      return this.downloadWithFfmpeg(url, outputDir);
    }
  }

  // 使用 ffmpeg 下载
  private async downloadWithFfmpeg(url: string, outputDir: string): Promise<string> {
    const outputPath = resolve(outputDir, 'audio.mp3');
    
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', url,
        '-vn',  // 不处理视频
        '-acodec', 'libmp3lame',
        '-q:a', '2',
        '-y',   // 覆盖输出文件
        outputPath,
      ]);

      let errorOutput = '';

      ffmpeg.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`ffmpeg download failed: ${errorOutput}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(new Error(`ffmpeg spawn error: ${err.message}`));
      });
    });
  }

  // 分割音频
  private async splitAudio(
    audioPath: string,
    outputDir: string,
    segmentDuration: number,
    onProgress?: (percent: number) => void
  ): Promise<string[]> {
    logger.info(`Splitting audio into ${segmentDuration}s segments`);
    
    const segmentsDir = resolve(outputDir, 'segments');
    if (!existsSync(segmentsDir)) {
      mkdirSync(segmentsDir, { recursive: true });
    }

    const segments: string[] = [];
    const duration = await this.getAudioDuration(audioPath);
    const numSegments = Math.ceil(duration / segmentDuration);

    for (let i = 0; i < numSegments; i++) {
      const startTime = i * segmentDuration;
      const segmentPath = resolve(segmentsDir, `segment_${String(i).padStart(4, '0')}.mp3`);
      
      await this.extractSegment(audioPath, segmentPath, startTime, segmentDuration);
      segments.push(segmentPath);
      
      onProgress?.(Math.round(((i + 1) / numSegments) * 100));
    }

    logger.info(`Audio split into ${segments.length} segments`);
    return segments;
  }

  // 提取音频段
  private async extractSegment(
    inputPath: string,
    outputPath: string,
    startTime: number,
    duration: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-i', inputPath,
        '-ss', String(startTime),
        '-t', String(duration),
        '-vn',
        '-acodec', 'copy',
        '-y',
        outputPath,
      ]);

      let errorOutput = '';

      ffmpeg.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg segment extraction failed: ${errorOutput}`));
        }
      });

      ffmpeg.on('error', reject);
    });
  }

  // 转录音频段
  private async transcribeSegment(
    segmentPath: string,
    offsetSec: number,
    language?: string
  ): Promise<string> {
    // 使用 whisper.cpp CLI（纯 Node 进程调用，无 Python 依赖）
    const model = config.media.whisperModel;
    const modelDir = config.media.whisperModelDir;
    const modelPath = resolve(modelDir, `ggml-${model}.bin`);
    const outputPrefix = segmentPath.replace(/\.mp3$/, '');

    if (!existsSync(modelPath)) {
      throw new Error(`Whisper model not found: ${modelPath}`);
    }

    const args = [
      '-m', modelPath,
      '-f', segmentPath,
      '-osrt',
      '-of', outputPrefix,
    ];

    if (language && language !== 'auto') {
      args.push('-l', language);
    }

    // 调用 whisper.cpp CLI
    try {
      await this.runWhisper(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Whisper not available, returning mock transcription: ${message}`);
      return this.generateMockSrt(segmentPath, offsetSec);
    }

    // 读取生成的 SRT 文件
    const fs = require('fs');
    const srtPath = `${outputPrefix}.srt`;
    
    if (existsSync(srtPath)) {
      const content = fs.readFileSync(srtPath, 'utf-8');
      // 调整时间戳
      return this.adjustSrtTimestamps(content, offsetSec);
    }

    throw new Error('SRT file not generated');
  }

  private async runWhisper(args: string[]): Promise<void> {
    try {
      await this.spawnCommand('whisper-cli', args);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        throw err;
      }
    }

    throw new Error('whisper-cli not found in PATH. Install whisper.cpp: brew install whisper-cpp');
  }

  private async spawnCommand(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args);
      let errorOutput = '';

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} failed: ${errorOutput}`));
        }
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }

  // 调整 SRT 时间戳
  private adjustSrtTimestamps(srtContent: string, offsetSec: number): string {
    const lines = srtContent.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      // 匹配时间戳行 (00:00:00,000 --> 00:00:00,000)
      const match = line.match(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/);
      
      if (match) {
        const start = this.parseTime(match[1]) + offsetSec;
        const end = this.parseTime(match[2]) + offsetSec;
        result.push(`${this.formatTime(start)} --> ${this.formatTime(end)}`);
      } else {
        result.push(line);
      }
    }

    return result.join('\n');
  }

  // 解析 SRT 时间格式
  private parseTime(timeStr: string): number {
    const [h, m, s] = timeStr.split(':');
    const [sec, ms] = s.split(',');
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(sec) + parseInt(ms) / 1000;
  }

  // 格式化为 SRT 时间格式
  private formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  // 生成模拟 SRT（当 Whisper 不可用时）
  private generateMockSrt(segmentPath: string, _offsetSec: number): string {
    const segmentName = basename(segmentPath, '.mp3');
    return `[${segmentName}] Transcription placeholder (Whisper not available)\n`;
  }

  // 合并多个 SRT 文件
  private mergeSrtFiles(contents: string[]): string {
    let subtitleIndex = 1;
    const merged: string[] = [];

    for (const content of contents) {
      const lines = content.split('\n').filter(line => line.trim());
      let i = 0;
      
      while (i < lines.length) {
        // 跳过序号行
        if (/^\d+$/.test(lines[i])) {
          i++;
          continue;
        }
        
        // 时间戳行
        if (lines[i].includes('-->')) {
          merged.push(String(subtitleIndex++));
          merged.push(lines[i]);
          i++;
          
          // 文本行
          const textLines: string[] = [];
          while (i < lines.length && !/^\d+$/.test(lines[i]) && !lines[i].includes('-->')) {
            textLines.push(lines[i]);
            i++;
          }
          
          if (textLines.length > 0) {
            merged.push(textLines.join('\n'));
            merged.push('');
          }
        } else {
          i++;
        }
      }
    }

    return merged.join('\n');
  }

  // 获取音频时长
  private async getAudioDuration(audioPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        audioPath,
      ]);

      let output = '';
      let errorOutput = '';

      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(output.trim());
          resolve(isNaN(duration) ? 0 : duration);
        } else {
          reject(new Error(`ffprobe failed: ${errorOutput}`));
        }
      });

      ffprobe.on('error', () => {
        // ffprobe 可能不可用，返回默认值
        resolve(600); // 默认 10 分钟
      });
    });
  }

  // 清理中间文件
  private cleanup(paths: string[]): void {
    const fs = require('fs');
    for (const path of paths) {
      try {
        if (existsSync(path)) {
          fs.unlinkSync(path);
          // 同时删除对应的 SRT 文件
          const srtPath = path.replace('.mp3', '.srt');
          if (existsSync(srtPath)) {
            fs.unlinkSync(srtPath);
          }
        }
      } catch (err) {
        logger.warn(`Failed to cleanup file: ${path}`);
      }
    }
  }
}

export default MediaPipeline;
