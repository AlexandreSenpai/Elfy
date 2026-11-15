import {
  ConnectionFailureDto,
  DataChannelEnvelopeDto,
  PeerTelemetryDto,
  StreamQualityLimitationReason,
} from '../../domain/dtos';

/** Per-peer runtime WebRTC state tracked by the streaming engine. */
export interface PeerEntry {
  peerIdSafe: string;
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
  pendingLocalIce: RTCIceCandidateInit[];
  canEmitIce: boolean;
  signalingChain: Promise<void>;
  iceRestartCount: number;
  receivedRemoteIceCount: number;
  disconnectTimer: number | null;
  offerTimeoutTimer: number | null;
  createdAt: number;
  lastSeenAt: number;
  missedPingCount: number;
  sessionToken: string;
  makingOffer: boolean;
  ignoreOffer: boolean;
  initialHandshakeDone: boolean;
  pendingRenegotiation: boolean;
  remoteStream: MediaStream | null;
}

export interface BitrateSample {
  bytes: number;
  timestamp: number;
}

export interface PacketLossSample {
  packetsLost: number;
  packetsTotal: number;
}

export interface StatsSampleTracker {
  bitrate: Map<string, BitrateSample>;
  packetLoss: Map<string, PacketLossSample>;
}

/** @deprecated Alias kept for internal stats callers. */
export type OutboundBitrateSample = BitrateSample;

export const createStatsSampleTracker = (): StatsSampleTracker => ({
  bitrate: new Map<string, BitrateSample>(),
  packetLoss: new Map<string, PacketLossSample>(),
});

export const clearStatsSampleTracker = (tracker: StatsSampleTracker): void => {
  tracker.bitrate.clear();
  tracker.packetLoss.clear();
};

export const clearOutboundStatsSamples = (tracker: StatsSampleTracker): void => {
  for (const key of Array.from(tracker.bitrate.keys())) {
    if (key.includes(':out:')) {
      tracker.bitrate.delete(key);
    }
  }
};

export const prunePeerStatsSamples = (tracker: StatsSampleTracker, peerIdSafe: string): void => {
  const prefix = `${peerIdSafe}:`;
  for (const key of Array.from(tracker.bitrate.keys())) {
    if (key.startsWith(prefix)) {
      tracker.bitrate.delete(key);
    }
  }
  for (const key of Array.from(tracker.packetLoss.keys())) {
    if (key.startsWith(prefix)) {
      tracker.packetLoss.delete(key);
    }
  }
};

export interface StatsAccumulator {
  outboundFps: number;
  inboundFps: number;
  droppedFrames: number;
  rttMs: number;
  rttSamples: number;
  activeCodec: string;
  isHardwareAccelerated: boolean | null;
  encoderImplementation: string;
  qualityLimitationReason: StreamQualityLimitationReason;
  outboundBitrateKbps: number;
  inboundBitrateKbps: number;
  packetLossPercentTotal: number;
  packetLossSamples: number;
  jitterMsTotal: number;
  jitterSamples: number;
  audioCodec: string;
  audioBitrateKbps: number;
  audioJitterBufferMsTotal: number;
  audioJitterBufferSamples: number;
  audioPacketsLost: number;
  peerStats: Record<string, PeerTelemetryDto>;
}

export type DataChannelDispatchHandler = (
  entry: PeerEntry,
  envelope: DataChannelEnvelopeDto
) => Promise<void> | void;

/** Deterministic tie-breaker for WebRTC perfect negotiation glare handling. */
export const isPolitePeer = (localPeerIdSafe: string, remotePeerIdSafe: string): boolean => {
  return localPeerIdSafe.localeCompare(remotePeerIdSafe) > 0;
};

/** Serializes async signaling mutations per peer so offers/answers/ICE cannot interleave. */
export const enqueuePeerTask = (
  peers: Map<string, PeerEntry>,
  entry: PeerEntry,
  task: () => Promise<void>
): Promise<void> => {
  const run = entry.signalingChain
    .catch(() => {})
    .then(async () => {
      if (entry.pc.connectionState === 'closed' || peers.get(entry.peerIdSafe) !== entry) {
        return;
      }
      await task();
    });
  entry.signalingChain = run.catch(() => {});
  return run;
};

export const clearDisconnectTimer = (entry: PeerEntry): void => {
  if (entry.disconnectTimer === null) return;
  window.clearTimeout(entry.disconnectTimer);
  entry.disconnectTimer = null;
};

export const clearOfferTimeoutTimer = (entry: PeerEntry): void => {
  if (entry.offerTimeoutTimer === null) return;
  window.clearTimeout(entry.offerTimeoutTimer);
  entry.offerTimeoutTimer = null;
};

export const touchPeerActivity = (entry: PeerEntry): void => {
  entry.lastSeenAt = Date.now();
  entry.missedPingCount = 0;
};

export const isPeerEntryHealthy = (entry: PeerEntry | undefined): boolean => {
  if (!entry) return false;
  if (entry.pc.connectionState === 'closed' || entry.pc.connectionState === 'failed') {
    return false;
  }
  if (entry.pc.iceConnectionState === 'closed' || entry.pc.iceConnectionState === 'failed') {
    return false;
  }
  if (entry.initialHandshakeDone && entry.dataChannel?.readyState !== 'open') {
    return false;
  }
  return true;
};

export const isPeerEntryConnected = (entry: PeerEntry | undefined): boolean => {
  if (!entry) return false;
  if (!entry.initialHandshakeDone || entry.dataChannel?.readyState !== 'open') {
    return false;
  }
  return isPeerEntryHealthy(entry);
};

export const isDataChannelTransportHealthy = (entry: PeerEntry): boolean => {
  if (entry.dataChannel?.readyState !== 'open') return false;
  const ice = entry.pc.iceConnectionState;
  return ice !== 'failed' && ice !== 'closed';
};

export const buildConnectionFailure = (entry: PeerEntry): ConnectionFailureDto => {
  const details = `peer=${entry.peerIdSafe}, connectionState=${entry.pc.connectionState}, iceConnectionState=${entry.pc.iceConnectionState}, iceGatheringState=${entry.pc.iceGatheringState}, receivedRemoteIceCount=${entry.receivedRemoteIceCount}, iceRestarts=${entry.iceRestartCount}`;

  if (entry.initialHandshakeDone) {
    return {
      stage: 'peer_disconnected',
      reason: 'Lost active P2P stream connection with remote peer.',
      details,
      peerIdSafe: entry.peerIdSafe,
      timestamp: Date.now(),
    };
  }

  if (entry.receivedRemoteIceCount === 0) {
    return {
      stage: 'ice_negotiation',
      reason: 'ICE negotiation failed (0 network candidates received from remote peer).',
      details,
      peerIdSafe: entry.peerIdSafe,
      timestamp: Date.now(),
    };
  }

  return {
    stage: 'ice_negotiation',
    reason: 'WebRTC NAT/Firewall negotiation failed across available network routes.',
    details,
    peerIdSafe: entry.peerIdSafe,
    timestamp: Date.now(),
  };
};

/** Rebuilds a clean MediaStream replacing any stale or same-kind track on track/unmute events. */
export const buildFreshRemoteStream = (
  entry: PeerEntry,
  incomingTrack?: MediaStreamTrack
): MediaStream | null => {
  const tracks: MediaStreamTrack[] = [];
  const existingTracks = entry.remoteStream?.getTracks() ?? [];

  for (const track of existingTracks) {
    if (track.readyState === 'ended') continue;
    if (incomingTrack && (track.id === incomingTrack.id || track.kind === incomingTrack.kind)) {
      continue;
    }
    tracks.push(track);
  }

  if (incomingTrack && incomingTrack.readyState !== 'ended') {
    tracks.push(incomingTrack);
  }

  if (tracks.length === 0) return null;
  return new MediaStream(tracks);
};

/** Detaches event listeners and closes a peer's DataChannel and RTCPeerConnection. */
export const detachAndClosePeerEntry = (entry: PeerEntry): void => {
  clearDisconnectTimer(entry);
  clearOfferTimeoutTimer(entry);
  entry.pc.onicecandidate = null;
  entry.pc.ontrack = null;
  entry.pc.ondatachannel = null;
  entry.pc.onsignalingstatechange = null;
  entry.pc.oniceconnectionstatechange = null;
  entry.pc.onconnectionstatechange = null;

  for (const sender of entry.pc.getSenders()) {
    try {
      void sender.replaceTrack(null).catch(() => {});
    } catch {
      // Ignore errors detaching track before closing sender.
    }
    try {
      entry.pc.removeTrack(sender);
    } catch {
      // Ignore errors removing senders on an already closing RTCPeerConnection.
    }
  }

  if (entry.dataChannel) {
    entry.dataChannel.onopen = null;
    entry.dataChannel.onmessage = null;
    entry.dataChannel.onclose = null;
    entry.dataChannel.onerror = null;
    try {
      entry.dataChannel.close();
    } catch {
      // Ignore errors closing an already closing/closed DataChannel.
    }
    entry.dataChannel = null;
  }

  try {
    entry.pc.close();
  } catch {
    // Ignore errors closing an already closed RTCPeerConnection.
  }
};
