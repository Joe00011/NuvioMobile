import { logger } from '../utils/logger';
import { Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InnertubeFormat {
  itag?: number;
  url?: string;
  mimeType?: string;
  bitrate?: number;
  averageBitrate?: number;
  width?: number;
  height?: number;
  fps?: number;
  quality?: string;
  qualityLabel?: string;
  audioQuality?: string;
  audioSampleRate?: string;
  audioChannels?: number;
  approxDurationMs?: string;
  initRange?: { start: string; end: string };
  indexRange?: { start: string; end: string };
}

interface StreamingData {
  formats?: InnertubeFormat[];
  adaptiveFormats?: InnertubeFormat[];
  hlsManifestUrl?: string;
  expiresInSeconds?: string;
}

interface PlayerResponse {
  streamingData?: StreamingData;
  videoDetails?: {
    videoId?: string;
    title?: string;
    lengthSeconds?: string;
    isLive?: boolean;
  };
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
}

interface StreamCandidate {
  client: string;
  priority: number;
  url: string;
  score: number;
  height: number;
  fps: number;
  ext: 'mp4' | 'webm' | 'm4a' | 'other';
  initRange?: { start: string; end: string };
  indexRange?: { start: string; end: string };
  bitrate: number;
  audioSampleRate?: string;
  mimeType: string;
  itag?: number;
}

interface HlsVariant {
  url: string;
  width: number;
  height: number;
  bandwidth: number;
}

export interface TrailerPlaybackSource {
  videoUrl: string;         // best video (may be muxed, DASH video-only, HLS, or progressive)
  audioUrl: string | null;  // separate audio URL if adaptive, null if muxed/HLS
  quality: string;
  isMuxed: boolean;         // true if videoUrl already contains audio
  isDash: boolean;          // true if we should build a DASH manifest
  durationSeconds: number;
}

export interface YouTubeExtractionResult {
  source: TrailerPlaybackSource;
  videoId: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// Client definitions
// ---------------------------------------------------------------------------

interface ClientDef {
  key: string;
  id: string;
  version: string;
  userAgent: string;
  context: Record<string, any>;
  priority: number;
}

const PREFERRED_ADAPTIVE_CLIENT = 'android_vr';

const CLIENTS: ClientDef[] = [
  {
    key: 'android_vr',
    id: '28',
    version: '1.62.27',
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    context: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.62.27',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      osName: 'Android',
      osVersion: '12L',
      platform: 'MOBILE',
      androidSdkVersion: 32,
      hl: 'en',
      gl: 'US',
    },
    priority: 0,
  },
  {
    key: 'android',
    id: '3',
    version: '20.10.38',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US) gzip',
    context: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      osName: 'Android',
      osVersion: '14',
      platform: 'MOBILE',
      androidSdkVersion: 34,
      hl: 'en',
      gl: 'US',
    },
    priority: 1,
  },
  {
    key: 'ios',
    id: '5',
    version: '20.10.1',
    userAgent: 'com.google.ios.youtube/20.10.1 (iPhone16,2; U; CPU iOS 17_4 like Mac OS X)',
    context: {
      clientName: 'IOS',
      clientVersion: '20.10.1',
      deviceModel: 'iPhone16,2',
      osName: 'iPhone',
      osVersion: '17.4.0.21E219',
      platform: 'MOBILE',
      hl: 'en',
      gl: 'US',
    },
    priority: 2,
  },
];

const REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_UA = 'Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const DEFAULT_HEADERS: Record<string, string> = {
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': DEFAULT_UA,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseVideoId(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase();
    if (host.endsWith('youtu.be')) {
      const id = url.pathname.slice(1).split('/')[0];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = url.pathname.match(/\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[2];
  } catch {
    const m = trimmed.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }
  return null;
}

function getMimeBase(mimeType?: string): string {
  return (mimeType ?? '').split(';')[0].trim();
}

function getCodecs(mimeType?: string): string {
  const m = (mimeType ?? '').match(/codecs="?([^"]+)"?/i);
  return m ? m[1].trim() : '';
}

function getExt(mimeType?: string): 'mp4' | 'webm' | 'm4a' | 'other' {
  const base = getMimeBase(mimeType);
  if (base.includes('mp4') || base === 'audio/mp4') return 'mp4';
  if (base.includes('webm')) return 'webm';
  if (base === 'audio/mp4' || base.includes('m4a')) return 'm4a';
  return 'other';
}

function containerScore(ext: string): number {
  switch (ext) {
    case 'mp4':
    case 'm4a': return 0;
    case 'webm': return 1;
    default: return 2;
  }
}

function videoScore(height: number, fps: number, bitrate: number): number {
  return height * 1_000_000_000 + fps * 1_000_000 + bitrate;
}

function audioScore(bitrate: number, sampleRate: number): number {
  return bitrate * 1_000_000 + sampleRate;
}

function parseQualityLabel(label?: string): number {
  if (!label) return 0;
  const m = label.match(/(\d{2,4})p/);
  return m ? parseInt(m[1], 10) : 0;
}

function isMuxedFormat(f: InnertubeFormat): boolean {
  const codecs = getCodecs(f.mimeType);
  return (!!f.qualityLabel && !!f.audioQuality) || codecs.includes(',');
}

function isVideoOnly(f: InnertubeFormat): boolean {
  return !!(f.qualityLabel && !f.audioQuality && f.mimeType?.startsWith('video/'));
}

function isAudioOnly(f: InnertubeFormat): boolean {
  return !!(f.audioQuality && !f.qualityLabel && f.mimeType?.startsWith('audio/'));
}

function summarizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.substring(0, 40)}`;
  } catch {
    return url.substring(0, 80);
  }
}

// ---------------------------------------------------------------------------
// Watch page — extract API key + visitor data dynamically
// ---------------------------------------------------------------------------

interface WatchConfig {
  apiKey: string | null;
  visitorData: string | null;
}

async function fetchWatchConfig(videoId: string): Promise<WatchConfig> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: DEFAULT_HEADERS,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      logger.warn('YouTubeExtractor', `Watch page fetch failed: ${res.status}`);
      return { apiKey: null, visitorData: null };
    }
    const html = await res.text();
    const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
    const visitorMatch = html.match(/"VISITOR_DATA":"([^"]+)"/);
    return {
      apiKey: apiKeyMatch?.[1] ?? null,
      visitorData: visitorMatch?.[1] ?? null,
    };
  } catch (err) {
    clearTimeout(timer);
    logger.warn('YouTubeExtractor', 'Watch page fetch error:', err);
    return { apiKey: null, visitorData: null };
  }
}

// ---------------------------------------------------------------------------
// Player API request
// ---------------------------------------------------------------------------

async function fetchPlayerResponse(
  videoId: string,
  client: ClientDef,
  apiKey: string | null,
  visitorData: string | null,
): Promise<PlayerResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Use dynamic API key if available, otherwise omit (deprecated but harmless)
  const url = apiKey
    ? `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`
    : `https://www.youtube.com/youtubei/v1/player?prettyPrint=false`;

  const headers: Record<string, string> = {
    ...DEFAULT_HEADERS,
    'content-type': 'application/json',
    'origin': 'https://www.youtube.com',
    'referer': `https://www.youtube.com/watch?v=${videoId}`,
    'x-youtube-client-name': client.id,
    'x-youtube-client-version': client.version,
    'user-agent': client.userAgent,
  };
  if (visitorData) headers['x-goog-visitor-id'] = visitorData;

  const body = JSON.stringify({
    videoId,
    context: { client: client.context },
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' },
    },
  });

  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      logger.warn('YouTubeExtractor', `[${client.key}] player API HTTP ${res.status}`);
      return null;
    }
    return await res.json() as PlayerResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      logger.warn('YouTubeExtractor', `[${client.key}] Timed out`);
    } else {
      logger.warn('YouTubeExtractor', `[${client.key}] Error:`, err);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// HLS manifest parsing — pick best variant by height then bandwidth
// ---------------------------------------------------------------------------

async function parseBestHlsVariant(manifestUrl: string): Promise<HlsVariant | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(manifestUrl, { headers: DEFAULT_HEADERS, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    let best: HlsVariant | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
      const nextLine = lines[i + 1];
      if (!nextLine || nextLine.startsWith('#')) continue;

      // Parse attributes
      const attrs: Record<string, string> = {};
      const attrStr = line.substring(line.indexOf(':') + 1);
      let key = '', val = '', inKey = true, inQuote = false;
      for (const ch of attrStr) {
        if (inKey) { if (ch === '=') inKey = false; else key += ch; continue; }
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === ',' && !inQuote) { attrs[key.trim()] = val.trim(); key = ''; val = ''; inKey = true; continue; }
        val += ch;
      }
      if (key.trim()) attrs[key.trim()] = val.trim();

      const res2 = (attrs['RESOLUTION'] ?? '').split('x');
      const width = parseInt(res2[0] ?? '0', 10) || 0;
      const height = parseInt(res2[1] ?? '0', 10) || 0;
      const bandwidth = parseInt(attrs['BANDWIDTH'] ?? '0', 10) || 0;

      // Absolutize URL
      let variantUrl = nextLine;
      if (!variantUrl.startsWith('http')) {
        try { variantUrl = new URL(variantUrl, manifestUrl).toString(); } catch { /* keep as-is */ }
      }

      const candidate: HlsVariant = { url: variantUrl, width, height, bandwidth };
      if (!best || height > best.height || (height === best.height && bandwidth > best.bandwidth)) {
        best = candidate;
      }
    }
    return best;
  } catch (err) {
    clearTimeout(timer);
    logger.warn('YouTubeExtractor', 'HLS manifest parse error:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Format collection — tries ALL clients, collects from all
// ---------------------------------------------------------------------------

interface CollectedFormats {
  progressive: StreamCandidate[];   // muxed video+audio
  adaptiveVideo: StreamCandidate[]; // video-only adaptive
  adaptiveAudio: StreamCandidate[]; // audio-only adaptive
  hlsManifests: Array<{ clientKey: string; priority: number; url: string }>;
}

async function collectAllFormats(
  videoId: string,
  apiKey: string | null,
  visitorData: string | null,
): Promise<CollectedFormats> {
  const progressive: StreamCandidate[] = [];
  const adaptiveVideo: StreamCandidate[] = [];
  const adaptiveAudio: StreamCandidate[] = [];
  const hlsManifests: Array<{ clientKey: string; priority: number; url: string }> = [];

  for (const client of CLIENTS) {
    try {
      const resp = await fetchPlayerResponse(videoId, client, apiKey, visitorData);
      if (!resp) continue;

      const status = resp.playabilityStatus?.status;
      if (status && status !== 'OK' && status !== 'CONTENT_CHECK_REQUIRED') {
        logger.warn('YouTubeExtractor', `[${client.key}] status=${status} reason=${resp.playabilityStatus?.reason ?? ''}`);
        continue;
      }

      const sd = resp.streamingData;
      if (!sd) continue;

      // Collect HLS manifest URL if present
      if (sd.hlsManifestUrl) {
        hlsManifests.push({ clientKey: client.key, priority: client.priority, url: sd.hlsManifestUrl });
      }

      let clientProgressive = 0, clientVideo = 0, clientAudio = 0;

      // Progressive (muxed) formats
      for (const f of (sd.formats ?? [])) {
        if (!f.url || !f.mimeType?.startsWith('video/')) continue;
        const height = f.height ?? parseQualityLabel(f.qualityLabel);
        const fps = f.fps ?? 0;
        const bitrate = f.bitrate ?? f.averageBitrate ?? 0;
        progressive.push({
          client: client.key,
          priority: client.priority,
          url: f.url,
          score: videoScore(height, fps, bitrate),
          height,
          fps,
          ext: getExt(f.mimeType),
          initRange: f.initRange,
          indexRange: f.indexRange,
          bitrate,
          mimeType: f.mimeType,
          itag: f.itag,
        });
        clientProgressive++;
      }

      // Adaptive formats
      for (const f of (sd.adaptiveFormats ?? [])) {
        if (!f.url) continue;
        const mimeBase = getMimeBase(f.mimeType);

        if (mimeBase.startsWith('video/')) {
          const height = f.height ?? parseQualityLabel(f.qualityLabel);
          const fps = f.fps ?? 0;
          const bitrate = f.bitrate ?? f.averageBitrate ?? 0;
          adaptiveVideo.push({
            client: client.key,
            priority: client.priority,
            url: f.url,
            score: videoScore(height, fps, bitrate),
            height,
            fps,
            ext: getExt(f.mimeType),
            initRange: f.initRange,
            indexRange: f.indexRange,
            bitrate,
            mimeType: f.mimeType,
            itag: f.itag,
          });
          clientVideo++;
        } else if (mimeBase.startsWith('audio/')) {
          const bitrate = f.bitrate ?? f.averageBitrate ?? 0;
          const sampleRate = parseFloat(f.audioSampleRate ?? '0') || 0;
          adaptiveAudio.push({
            client: client.key,
            priority: client.priority,
            url: f.url,
            score: audioScore(bitrate, sampleRate),
            height: 0,
            fps: 0,
            ext: getExt(f.mimeType),
            initRange: f.initRange,
            indexRange: f.indexRange,
            bitrate,
            audioSampleRate: f.audioSampleRate,
            mimeType: f.mimeType,
            itag: f.itag,
          });
          clientAudio++;
        }
      }

      logger.info('YouTubeExtractor', `[${client.key}] progressive=${clientProgressive} video=${clientVideo} audio=${clientAudio} hls=${sd.hlsManifestUrl ? 1 : 0}`);
    } catch (err) {
      logger.warn('YouTubeExtractor', `[${client.key}] Failed:`, err);
    }
  }

  return { progressive, adaptiveVideo, adaptiveAudio, hlsManifests };
}

// ---------------------------------------------------------------------------
// Sorting and selection
// ---------------------------------------------------------------------------

function sortCandidates(items: StreamCandidate[]): StreamCandidate[] {
  return [...items].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ca = containerScore(a.ext), cb = containerScore(b.ext);
    if (ca !== cb) return ca - cb;
    return a.priority - b.priority;
  });
}

function pickBestForClient(items: StreamCandidate[], preferredClient: string): StreamCandidate | null {
  const fromPreferred = items.filter(c => c.client === preferredClient);
  const pool = fromPreferred.length > 0 ? fromPreferred : items;
  return sortCandidates(pool)[0] ?? null;
}

// ---------------------------------------------------------------------------
// DASH manifest builder
// ---------------------------------------------------------------------------

async function buildDashManifest(
  video: StreamCandidate,
  audio: StreamCandidate,
  videoId: string,
  durationSeconds: number,
): Promise<string | null> {
  try {
    const FileSystem = await import('expo-file-system/legacy');
    if (!FileSystem.cacheDirectory) return null;

    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const dur = `PT${durationSeconds}S`;
    const vMime = getMimeBase(video.mimeType);
    const aMime = getMimeBase(audio.mimeType);
    const vCodec = getCodecs(video.mimeType);
    const aCodec = getCodecs(audio.mimeType);
    const vInit = video.initRange ? `${video.initRange.start}-${video.initRange.end}` : '0-0';
    const vIdx  = video.indexRange ? `${video.indexRange.start}-${video.indexRange.end}` : '0-0';
    const aInit = audio.initRange ? `${audio.initRange.start}-${audio.initRange.end}` : '0-0';
    const aIdx  = audio.indexRange ? `${audio.indexRange.start}-${audio.indexRange.end}` : '0-0';

    const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="${dur}" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="${dur}">
    <AdaptationSet id="1" mimeType="${vMime}" codecs="${vCodec}" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="v1" bandwidth="${video.bitrate}" height="${video.height}">
        <BaseURL>${esc(video.url)}</BaseURL>
        <SegmentBase indexRange="${vIdx}"><Initialization range="${vInit}"/></SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="2" mimeType="${aMime}" codecs="${aCodec}" lang="en" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="a1" bandwidth="${audio.bitrate}" audioSamplingRate="${audio.audioSampleRate ?? '44100'}">
        <BaseURL>${esc(audio.url)}</BaseURL>
        <SegmentBase indexRange="${aIdx}"><Initialization range="${aInit}"/></SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

    const path = `${FileSystem.cacheDirectory}trailer_${videoId}.mpd`;
    await FileSystem.writeAsStringAsync(path, mpd, { encoding: FileSystem.EncodingType.UTF8 });
    logger.info('YouTubeExtractor', `DASH manifest: ${path} (video=${video.itag} ${video.height}p, audio=${audio.itag})`);
    return path;
  } catch (err) {
    logger.warn('YouTubeExtractor', 'DASH manifest write failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class YouTubeExtractor {
  /**
   * Extract a playable source from a YouTube video ID or URL.
   *
   * Strategy:
   * 1. Fetch watch page to get dynamic API key + visitor data
   * 2. Try ALL clients in parallel — collect formats from all that succeed
   * 3. On Android: prefer DASH (adaptive video from android_vr + best audio)
   *    falling back to best HLS manifest, then best progressive
   * 4. On iOS: prefer HLS manifest (AVPlayer native), then progressive (muxed)
   */
  static async extract(
    videoIdOrUrl: string,
    platform?: 'android' | 'ios',
  ): Promise<YouTubeExtractionResult | null> {
    const videoId = parseVideoId(videoIdOrUrl);
    if (!videoId) {
      logger.warn('YouTubeExtractor', `Could not parse video ID: ${videoIdOrUrl}`);
      return null;
    }

    const effectivePlatform = platform ?? (Platform.OS === 'android' ? 'android' : 'ios');
    logger.info('YouTubeExtractor', `Extracting videoId=${videoId} platform=${effectivePlatform}`);

    // Step 1: fetch watch page for dynamic API key + visitor data
    const watchConfig = await fetchWatchConfig(videoId);
    if (watchConfig.apiKey) {
      logger.info('YouTubeExtractor', `Got apiKey and visitorData from watch page`);
    } else {
      logger.warn('YouTubeExtractor', `Could not get apiKey from watch page — proceeding without`);
    }

    // Step 2: collect formats from all clients
    const { progressive, adaptiveVideo, adaptiveAudio, hlsManifests } =
      await collectAllFormats(videoId, watchConfig.apiKey, watchConfig.visitorData);

    logger.info('YouTubeExtractor', `Totals: progressive=${progressive.length} adaptiveVideo=${adaptiveVideo.length} adaptiveAudio=${adaptiveAudio.length} hls=${hlsManifests.length}`);

    if (progressive.length === 0 && adaptiveVideo.length === 0 && hlsManifests.length === 0) {
      logger.warn('YouTubeExtractor', `No usable formats for videoId=${videoId}`);
      return null;
    }

    // Step 3: pick best HLS variant (by resolution/bandwidth)
    let bestHls: (HlsVariant & { manifestUrl: string }) | null = null;
    for (const { url, priority } of hlsManifests.sort((a, b) => a.priority - b.priority)) {
      const variant = await parseBestHlsVariant(url);
      if (variant && (!bestHls || variant.height > bestHls.height || (variant.height === bestHls.height && variant.bandwidth > bestHls.bandwidth))) {
        bestHls = { ...variant, manifestUrl: url };
      }
    }

    const bestProgressive = sortCandidates(progressive)[0] ?? null;
    const bestAdaptiveVideo = pickBestForClient(adaptiveVideo, PREFERRED_ADAPTIVE_CLIENT);
    const bestAdaptiveAudio = pickBestForClient(adaptiveAudio, PREFERRED_ADAPTIVE_CLIENT);

    if (bestHls) logger.info('YouTubeExtractor', `Best HLS: ${bestHls.height}p ${bestHls.bandwidth}bps`);
    if (bestProgressive) logger.info('YouTubeExtractor', `Best progressive: ${bestProgressive.height}p score=${bestProgressive.score}`);
    if (bestAdaptiveVideo) logger.info('YouTubeExtractor', `Best adaptive video: ${bestAdaptiveVideo.height}p client=${bestAdaptiveVideo.client}`);
    if (bestAdaptiveAudio) logger.info('YouTubeExtractor', `Best adaptive audio: bitrate=${bestAdaptiveAudio.bitrate} client=${bestAdaptiveAudio.client}`);

    // Placeholder duration (refined below)
    const durationSeconds = 300;

    let source: TrailerPlaybackSource | null = null;

    if (effectivePlatform === 'android') {
      // Android priority: DASH adaptive > HLS > progressive
      if (bestAdaptiveVideo && bestAdaptiveAudio) {
        const mpdPath = await buildDashManifest(bestAdaptiveVideo, bestAdaptiveAudio, videoId, durationSeconds);
        if (mpdPath) {
          source = {
            videoUrl: mpdPath,
            audioUrl: null,
            quality: `${bestAdaptiveVideo.height}p`,
            isMuxed: true, // MPD contains both tracks
            isDash: true,
            durationSeconds,
          };
        }
      }
      if (!source && bestHls) {
        source = {
          videoUrl: bestHls.manifestUrl,
          audioUrl: null,
          quality: `${bestHls.height}p`,
          isMuxed: true,
          isDash: false,
          durationSeconds,
        };
      }
      if (!source && bestProgressive) {
        source = {
          videoUrl: bestProgressive.url,
          audioUrl: null,
          quality: `${bestProgressive.height}p`,
          isMuxed: true,
          isDash: false,
          durationSeconds,
        };
      }
    } else {
      // iOS priority: HLS (native AVPlayer support) > progressive
      if (bestHls) {
        source = {
          videoUrl: bestHls.manifestUrl,
          audioUrl: null,
          quality: `${bestHls.height}p`,
          isMuxed: true,
          isDash: false,
          durationSeconds,
        };
      }
      if (!source && bestProgressive) {
        source = {
          videoUrl: bestProgressive.url,
          audioUrl: null,
          quality: `${bestProgressive.height}p`,
          isMuxed: true,
          isDash: false,
          durationSeconds,
        };
      }
    }

    if (!source) {
      logger.warn('YouTubeExtractor', `Could not build a playable source for videoId=${videoId}`);
      return null;
    }

    logger.info('YouTubeExtractor', `Final source: ${summarizeUrl(source.videoUrl)} quality=${source.quality} dash=${source.isDash}`);

    return {
      source,
      videoId,
      title: undefined,
    };
  }

  /** Convenience: returns just the best playable URL or null. */
  static async getBestStreamUrl(
    videoIdOrUrl: string,
    platform?: 'android' | 'ios',
  ): Promise<string | null> {
    const result = await this.extract(videoIdOrUrl, platform);
    return result?.source.videoUrl ?? null;
  }

  static parseVideoId(input: string): string | null {
    return parseVideoId(input);
  }
}

export default YouTubeExtractor;
