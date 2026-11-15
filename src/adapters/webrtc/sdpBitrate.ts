/** Target video bandwidth parameters applied to remote SDP before `setRemoteDescription`. */
export interface SdpVideoBitrateHints {
  startKbps: number;
  minKbps: number;
  maxKbps: number;
}

const GOOGLE_BITRATE_KEYS = [
  'x-google-start-bitrate=',
  'x-google-min-bitrate=',
  'x-google-max-bitrate=',
] as const;

const NON_PRIMARY_VIDEO_CODECS = /^(?:rtx|red|ulpfec)\//i;

const isPositiveFinite = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

/**
 * Inspects an SDP payload's `m=video` sections and returns payload types that
 * represent retransmission or redundancy wrappers rather than primary video codecs.
 */
const collectNonPrimaryVideoPayloadTypes = (lines: string[]): Set<string> => {
  const excluded = new Set<string>();
  let inVideoSection = false;

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inVideoSection = line.startsWith('m=video ');
      continue;
    }
    if (!inVideoSection) continue;

    if (line.startsWith('a=rtpmap:')) {
      const match = line.match(/^a=rtpmap:(\d+)\s+([^\s]+)/);
      if (match && NON_PRIMARY_VIDEO_CODECS.test(match[2])) {
        excluded.add(match[1]);
      }
      continue;
    }

    if (line.startsWith('a=fmtp:')) {
      const match = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
      if (match && /(?:^|;)\s*apt=/.test(match[2])) {
        excluded.add(match[1]);
      }
    }
  }

  return excluded;
};

/**
 * Injects `b=AS` and `x-google-*-bitrate` fmtp hints into `m=video` sections so
 * Chromium/WebView2 BWE ramps hardware encoders up immediately instead of stalling near 300 kbps.
 */
export const applyVideoBitrateHintsToSdp = (
  sdp: string,
  hints: SdpVideoBitrateHints
): string => {
  if (!sdp || !sdp.includes('m=video ')) return sdp;
  if (
    !isPositiveFinite(hints.startKbps) ||
    !isPositiveFinite(hints.minKbps) ||
    !isPositiveFinite(hints.maxKbps)
  ) {
    return sdp;
  }

  const startKbps = Math.round(hints.startKbps);
  const minKbps = Math.min(startKbps, Math.round(hints.minKbps));
  const maxKbps = Math.max(startKbps, Math.round(hints.maxKbps));
  const lineEnding = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const excludedPayloadTypes = collectNonPrimaryVideoPayloadTypes(lines);

  const hintParams = [
    `x-google-start-bitrate=${startKbps}`,
    `x-google-min-bitrate=${minKbps}`,
    `x-google-max-bitrate=${maxKbps}`,
  ];

  const output: string[] = [];
  let inVideoSection = false;
  let wroteBandwidthLine = false;

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inVideoSection = line.startsWith('m=video ');
      wroteBandwidthLine = false;
      output.push(line);
      continue;
    }

    if (!inVideoSection) {
      output.push(line);
      continue;
    }

    if (line.startsWith('b=AS:')) {
      if (!wroteBandwidthLine) {
        output.push(`b=AS:${maxKbps}`);
        wroteBandwidthLine = true;
      }
      continue;
    }

    if (line.startsWith('c=')) {
      output.push(line);
      if (!wroteBandwidthLine) {
        output.push(`b=AS:${maxKbps}`);
        wroteBandwidthLine = true;
      }
      continue;
    }

    if (line.startsWith('a=') && !wroteBandwidthLine) {
      output.push(`b=AS:${maxKbps}`);
      wroteBandwidthLine = true;
    }

    if (line.startsWith('a=fmtp:')) {
      const match = line.match(/^a=fmtp:(\d+)\s+(.*)$/);
      if (match && !excludedPayloadTypes.has(match[1])) {
        const cleanedParams = match[2]
          .split(';')
          .map((token) => token.trim())
          .filter(
            (token) =>
              token.length > 0 &&
              !GOOGLE_BITRATE_KEYS.some((prefix) => token.startsWith(prefix))
          );
        cleanedParams.push(...hintParams);
        output.push(`a=fmtp:${match[1]} ${cleanedParams.join(';')}`);
        continue;
      }
    }

    output.push(line);
  }

  return output.join(lineEnding);
};
