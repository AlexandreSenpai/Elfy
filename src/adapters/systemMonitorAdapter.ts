import { EMPTY_AUDIO_TELEMETRY } from '../domain/config';
import { HostResourceMetricsDto, MetricSourceKind, SystemMetricsDto } from '../domain/dtos';
import { IStreamEngine, ISystemMonitor, WebRtcStatsSnapshot } from '../ports';
import { getSystemMetricsTauri, isTauri } from '../utils/tauri';

interface PerformanceMemoryInfo {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

interface PerformanceWithMemory extends Performance {
  memory?: PerformanceMemoryInfo;
}

const HIGH_CPU_THRESHOLD = 85;
const HIGH_RAM_RATIO = 0.9;
const LOW_FPS_WARNING_THRESHOLD = 22;
const HIGH_DROPPED_FRAMES_THRESHOLD = 45;

const EMPTY_RTC_STATS: WebRtcStatsSnapshot = {
  outboundFps: 0,
  inboundFps: 0,
  localWidth: 0,
  localHeight: 0,
  localCaptureFps: 0,
  droppedFrames: 0,
  rttMs: 0,
  activeCodec: '',
  isHardwareAccelerated: null,
  encoderImplementation: '',
  qualityLimitationReason: 'none',
  outboundBitrateKbps: 0,
  inboundBitrateKbps: 0,
  packetLossPercent: 0,
  jitterMs: 0,
  audioCodec: '',
  audioBitrateKbps: 0,
  audioJitterBufferMs: 0,
  audioPacketsLost: 0,
  localAudio: { ...EMPTY_AUDIO_TELEMETRY },
  peerStats: {},
};

const measureBrowserEventLoopLoad = (): Promise<{ percent: number; source: MetricSourceKind }> => {
  if (typeof performance === 'undefined') {
    return Promise.resolve({ percent: 0, source: 'unavailable' });
  }

  return new Promise((resolve) => {
    const start = performance.now();
    globalThis.setTimeout(() => {
      const driftMs = Math.max(0, performance.now() - start - 16);
      const estimatedLoad = Math.min(100, Math.round(driftMs * 1.8));
      resolve({ percent: estimatedLoad, source: 'event-loop' });
    }, 16);
  });
};

const sampleBrowserHostMetrics = async (): Promise<
  HostResourceMetricsDto & { cpuSource: MetricSourceKind; memorySource: MetricSourceKind }
> => {
  const loopLoad = await measureBrowserEventLoopLoad();
  const perf = typeof performance !== 'undefined' ? (performance as PerformanceWithMemory) : null;
  const mem = perf?.memory;

  if (!mem || !mem.jsHeapSizeLimit) {
    return {
      cpuUsagePercent: loopLoad.percent,
      memoryUsedMb: 0,
      memoryTotalMb: 0,
      highLoadWarning: loopLoad.percent >= HIGH_CPU_THRESHOLD,
      cpuSource: loopLoad.source,
      memorySource: 'unavailable',
    };
  }

  const memoryUsedMb = Math.round(mem.usedJSHeapSize / (1024 * 1024));
  const memoryTotalMb = Math.max(1, Math.round(mem.jsHeapSizeLimit / (1024 * 1024)));
  const highRam = memoryUsedMb / memoryTotalMb >= HIGH_RAM_RATIO;

  return {
    cpuUsagePercent: loopLoad.percent,
    memoryUsedMb,
    memoryTotalMb,
    highLoadWarning: loopLoad.percent >= HIGH_CPU_THRESHOLD || highRam,
    cpuSource: loopLoad.source,
    memorySource: 'js-heap',
  };
};

/** Combines OS CPU/RAM metrics (Tauri sysinfo or honest browser heap/loop stats) with WebRTC stats. */
export class SystemMonitorAdapter implements ISystemMonitor {
  async sampleMetrics(streamEngine?: IStreamEngine): Promise<SystemMetricsDto> {
    const tauriMetrics = isTauri() ? await getSystemMetricsTauri() : null;
    const hostMetrics = tauriMetrics
      ? { ...tauriMetrics, cpuSource: 'system' as const, memorySource: 'system' as const }
      : await sampleBrowserHostMetrics();
    const rtcStats = streamEngine ? await streamEngine.getStatsSnapshot() : EMPTY_RTC_STATS;

    const softwareFallbackActive =
      rtcStats.isHardwareAccelerated === false && Boolean(rtcStats.activeCodec);
    // Windows Graphics Capture drops outbound FPS to 1-5 FPS on a static desktop even with
    // zero GPU/CPU contention, so only treat low FPS as overload when bottlenecked or on SW encode.
    const throttledLowFps =
      rtcStats.outboundFps > 0 &&
      rtcStats.outboundFps < LOW_FPS_WARNING_THRESHOLD &&
      (rtcStats.qualityLimitationReason !== 'none' || softwareFallbackActive);

    const streamStruggling =
      rtcStats.qualityLimitationReason === 'cpu' ||
      softwareFallbackActive ||
      throttledLowFps ||
      rtcStats.droppedFrames > HIGH_DROPPED_FRAMES_THRESHOLD;

    const cpuCores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 0 : 0;

    return {
      cpuUsagePercent: Math.round(hostMetrics.cpuUsagePercent),
      memoryUsedMb: hostMetrics.memoryUsedMb,
      memoryTotalMb: hostMetrics.memoryTotalMb,
      highLoadWarning: hostMetrics.highLoadWarning || streamStruggling,
      cpuSource: hostMetrics.cpuSource,
      memorySource: hostMetrics.memorySource,
      cpuCores,
      outboundFps: Math.round(rtcStats.outboundFps),
      inboundFps: Math.round(rtcStats.inboundFps),
      localWidth: rtcStats.localWidth,
      localHeight: rtcStats.localHeight,
      localCaptureFps: rtcStats.localCaptureFps,
      droppedFrames: rtcStats.droppedFrames,
      rttMs: Math.round(rtcStats.rttMs),
      activeCodec: rtcStats.activeCodec,
      isHardwareAccelerated: rtcStats.isHardwareAccelerated,
      encoderImplementation: rtcStats.encoderImplementation,
      qualityLimitationReason: rtcStats.qualityLimitationReason,
      outboundBitrateKbps: rtcStats.outboundBitrateKbps,
      inboundBitrateKbps: rtcStats.inboundBitrateKbps,
      packetLossPercent: rtcStats.packetLossPercent,
      jitterMs: rtcStats.jitterMs,
      audioCodec: rtcStats.audioCodec,
      audioBitrateKbps: rtcStats.audioBitrateKbps,
      audioJitterBufferMs: rtcStats.audioJitterBufferMs,
      audioPacketsLost: rtcStats.audioPacketsLost,
      localAudio: rtcStats.localAudio,
      peerStats: rtcStats.peerStats,
    };
  }
}

export const systemMonitorAdapter: ISystemMonitor = new SystemMonitorAdapter();
