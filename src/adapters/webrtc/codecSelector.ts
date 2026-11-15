export interface CodecEfficiencyInfo {
  supported: boolean;
  smooth: boolean;
  powerEfficient: boolean;
}

const AUXILIARY_MIME_TYPES = new Set([
  'video/rtx',
  'video/red',
  'video/ulpfec',
  'video/flexfec-03',
]);

const DEFAULT_EFFICIENCY: CodecEfficiencyInfo = {
  supported: true,
  smooth: false,
  powerEfficient: false,
};

let cachedEfficiencyMapPromise: Promise<Map<string, CodecEfficiencyInfo>> | null = null;

const getCodecCacheKey = (codec: RTCRtpCodec): string => {
  const mime = codec.mimeType.toLowerCase();
  const fmtp = (codec.sdpFmtpLine ?? '').trim().toLowerCase();
  return fmtp ? `${mime};${fmtp}` : mime;
};

const extractCodecContentType = (codec: RTCRtpCodec): string => {
  const fmtp = codec.sdpFmtpLine ?? '';
  const profileLevelMatch = fmtp.match(/profile-level-id=([0-9a-fA-F]+)/i);
  if (codec.mimeType.toLowerCase() === 'video/h264' && profileLevelMatch) {
    return `${codec.mimeType}; profile-level-id=${profileLevelMatch[1]}`;
  }

  const profileIdMatch = fmtp.match(/profile-id=([0-9a-fA-F]+)/i);
  if (profileIdMatch) {
    return `${codec.mimeType}; profile-id=${profileIdMatch[1]}`;
  }

  return codec.mimeType;
};

const queryMediaCapabilitiesWebRtc = async (
  contentType: string
): Promise<CodecEfficiencyInfo | null> => {
  if (typeof navigator === 'undefined' || !navigator.mediaCapabilities?.encodingInfo) {
    return null;
  }

  try {
    const res = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: {
        contentType,
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        framerate: 60,
      },
    });
    return {
      supported: Boolean(res.supported),
      smooth: Boolean(res.smooth),
      powerEfficient: Boolean(res.powerEfficient),
    };
  } catch {
    return null;
  }
};

const probeSingleCodecEfficiency = async (codec: RTCRtpCodec): Promise<CodecEfficiencyInfo> => {
  const withProfile = extractCodecContentType(codec);
  if (withProfile !== codec.mimeType) {
    const detailed = await queryMediaCapabilitiesWebRtc(withProfile);
    if (detailed && detailed.supported) return detailed;
  }

  const base = await queryMediaCapabilitiesWebRtc(codec.mimeType);
  return base ?? DEFAULT_EFFICIENCY;
};

const getCodecFamilyBaseScore = (mimeLower: string, fmtpLower: string): number => {
  if (mimeLower === 'video/h264') {
    const packetizationBonus = fmtpLower.includes('packetization-mode=1') ? 4 : 0;
    // Windows Edge/WebView2 MediaFoundation exposes HW NVENC/QSV/AMF on High (6400), Main (4d00),
    // and Baseline (4200), whereas Constrained Baseline (42e0) falls back to CPU OpenH264 even
    // when MediaCapabilities reports powerEfficient=false across all WebRTC profiles.
    if (fmtpLower.includes('profile-level-id=42e0')) return 18 + packetizationBonus;

    let score = 40 + packetizationBonus;
    if (fmtpLower.includes('profile-level-id=6400')) score += 16;
    else if (fmtpLower.includes('profile-level-id=4d00')) score += 12;
    else if (fmtpLower.includes('profile-level-id=4200')) score += 8;
    else score += 4;
    return score;
  }
  if (mimeLower === 'video/av1') return 35;
  if (mimeLower === 'video/vp9') return 25;
  if (mimeLower === 'video/vp8') return 10;
  return 1;
};

const scoreCodec = (
  codec: RTCRtpCodec,
  efficiencyMap: ReadonlyMap<string, CodecEfficiencyInfo>
): number => {
  const mimeLower = codec.mimeType.toLowerCase();
  const fmtpLower = (codec.sdpFmtpLine ?? '').toLowerCase();
  const info = efficiencyMap.get(getCodecCacheKey(codec)) ?? DEFAULT_EFFICIENCY;

  const hwBonus = info.powerEfficient ? 1000 : 0;
  const smoothBonus = info.smooth ? 200 : 0;
  return hwBonus + smoothBonus + getCodecFamilyBaseScore(mimeLower, fmtpLower);
};

/**
 * Probes WebRTC encoder power-efficiency via `MediaCapabilities` once per runtime session,
 * returning cached hardware/smooth capability indicators keyed by codec MIME + fmtp.
 */
export const probeWebRtcCodecEfficiency = (
  codecs: readonly RTCRtpCodec[]
): Promise<Map<string, CodecEfficiencyInfo>> => {
  if (cachedEfficiencyMapPromise) {
    return cachedEfficiencyMapPromise;
  }

  cachedEfficiencyMapPromise = (async () => {
    const map = new Map<string, CodecEfficiencyInfo>();
    const seenKeys = new Set<string>();
    const probes: Promise<void>[] = [];

    for (const codec of codecs) {
      const mimeLower = codec.mimeType.toLowerCase();
      if (AUXILIARY_MIME_TYPES.has(mimeLower)) continue;
      const key = getCodecCacheKey(codec);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      probes.push(
        probeSingleCodecEfficiency(codec).then((info) => {
          map.set(key, info);
        })
      );
    }

    await Promise.all(probes);
    return map;
  })();

  return cachedEfficiencyMapPromise;
};

/**
 * Pure comparator/sorter that places hardware (`powerEfficient`) video codecs ahead of
 * software fallbacks while prioritizing H.264 -> AV1 -> VP9 -> VP8 and preserving
 * auxiliary RTX/RED/ULPFEC payload types.
 */
export const rankVideoCodecsForHardware = (
  codecs: readonly RTCRtpCodec[],
  efficiencyMap: ReadonlyMap<string, CodecEfficiencyInfo>
): RTCRtpCodec[] => {
  const primary: RTCRtpCodec[] = [];
  const auxiliary: RTCRtpCodec[] = [];

  for (const codec of codecs) {
    if (AUXILIARY_MIME_TYPES.has(codec.mimeType.toLowerCase())) {
      auxiliary.push(codec);
      continue;
    }
    primary.push(codec);
  }

  primary.sort((a, b) => scoreCodec(b, efficiencyMap) - scoreCodec(a, efficiencyMap));
  return [...primary, ...auxiliary];
};

/**
 * Applies Elfy's automatic hardware-first video codec preference order to all active
 * video transceivers on a peer connection before SDP offer/answer generation.
 */
export const applyPreferredVideoCodecs = async (pc: RTCPeerConnection): Promise<void> => {
  if (pc.connectionState === 'closed') return;
  if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
    return;
  }

  const capabilities = RTCRtpSender.getCapabilities('video');
  if (!capabilities || capabilities.codecs.length === 0) return;

  const efficiencyMap = await probeWebRtcCodecEfficiency(capabilities.codecs);
  const orderedCodecs = rankVideoCodecsForHardware(capabilities.codecs, efficiencyMap);

  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.direction === 'stopped' || transceiver.currentDirection === 'stopped') {
      continue;
    }
    const kind = transceiver.sender.track?.kind ?? transceiver.receiver.track?.kind;
    if (kind && kind !== 'video') continue;
    if (typeof transceiver.setCodecPreferences !== 'function') continue;

    try {
      transceiver.setCodecPreferences(orderedCodecs);
    } catch {
      // Ignore synthetic/browser-specific transceiver states rejecting preference updates.
    }
  }
};
