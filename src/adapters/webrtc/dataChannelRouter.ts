import {
  DataChannelEnvelopeDto,
  DataChannelMessageType,
  DataChannelPayload,
} from '../../domain/dtos';
import { parseDataChannelMessage } from '../../domain/validators';
import { StreamEngineCallbacks } from '../../ports';
import { CaptureManager } from './captureManager';
import {
  DataChannelDispatchHandler,
  PeerEntry,
  buildConnectionFailure,
  clearOfferTimeoutTimer,
  isPeerEntryHealthy,
  touchPeerActivity,
} from './peerTypes';

export interface DataChannelRouterDeps {
  getLocalPeerIdSafe: () => string;
  getCallbacks: () => StreamEngineCallbacks;
  getPeers: () => Map<string, PeerEntry>;
  captureManager: CaptureManager;
  applyRemoteOffer: (
    entry: PeerEntry,
    sdp: RTCSessionDescriptionInit,
    preferDataChannel: boolean
  ) => Promise<void>;
  applyRemoteAnswer: (entry: PeerEntry, sdp: RTCSessionDescriptionInit) => Promise<void>;
  applyRemoteIce: (entry: PeerEntry, candidate: RTCIceCandidateInit) => Promise<void>;
  syncPeerWithLocalStream: (entry: PeerEntry) => void;
  closePeer: (remotePeerIdSafe: string) => void;
}

/**
 * Manages RTCDataChannel lifecycle, message validation/routing, keepalive ping/pong
 * health eviction, and in-band WebRTC renegotiation dispatch.
 */
export class DataChannelRouter {
  private readonly dcDispatch: Record<DataChannelMessageType, DataChannelDispatchHandler>;

  constructor(private readonly deps: DataChannelRouterDeps) {
    this.dcDispatch = {
      renegotiate_offer: (entry, env) => {
        if (env.payload.type !== 'renegotiate_offer') return;
        return this.deps.applyRemoteOffer(entry, env.payload.sdp, true);
      },
      renegotiate_answer: (entry, env) => {
        if (env.payload.type !== 'renegotiate_answer') return;
        return this.deps.applyRemoteAnswer(entry, env.payload.sdp);
      },
      renegotiate_ice: (entry, env) => {
        if (env.payload.type !== 'renegotiate_ice') return;
        return this.deps.applyRemoteIce(entry, env.payload.candidate);
      },
      ping: (entry, env) => this.handlePingMessage(entry, env),
      pong: (entry, env) => {
        this.deps.getCallbacks().onDataChannelMessage?.(entry.peerIdSafe, env);
      },
      peer_roster_sync: (entry, env) => {
        this.deps.getCallbacks().onDataChannelMessage?.(entry.peerIdSafe, env);
      },
      stream_started: (entry, env) => {
        this.deps.getCallbacks().onDataChannelMessage?.(entry.peerIdSafe, env);
      },
      stream_stopped: (entry, env) => {
        this.handleRemoteStreamStopped(entry, env);
      },
      peer_profile_updated: (entry, env) => {
        this.deps.getCallbacks().onDataChannelMessage?.(entry.peerIdSafe, env);
      },
      peer_left: (entry, env) => {
        this.deps.getCallbacks().onDataChannelMessage?.(entry.peerIdSafe, env);
      },
      peer_kicked: (entry, env) => {
        this.deps.getCallbacks().onDataChannelMessage?.(entry.peerIdSafe, env);
      },
    };
  }

  attachDataChannel(entry: PeerEntry, channel: RTCDataChannel): void {
    entry.dataChannel = channel;

    channel.onopen = () => {
      if (this.deps.getPeers().get(entry.peerIdSafe) !== entry) return;
      entry.initialHandshakeDone = true;
      touchPeerActivity(entry);
      clearOfferTimeoutTimer(entry);
      this.deps.getCallbacks().onDataChannelOpen?.(entry.peerIdSafe);
      if (
        this.deps.captureManager.getLocalStream() &&
        !this.deps.captureManager.hasNegotiatedLocalStream(entry)
      ) {
        this.deps.syncPeerWithLocalStream(entry);
      }
    };

    channel.onmessage = (event: MessageEvent) => {
      if (this.deps.getPeers().get(entry.peerIdSafe) !== entry) return;
      void this.handleRawDataChannelEvent(entry, event.data);
    };
  }

  private async handleRawDataChannelEvent(
    entry: PeerEntry,
    rawData: unknown
  ): Promise<void> {
    const envelope = parseDataChannelMessage(rawData);
    if (!envelope || envelope.sessionToken !== entry.sessionToken) return;
    entry.initialHandshakeDone = true;
    clearOfferTimeoutTimer(entry);
    touchPeerActivity(entry);

    const handler = this.dcDispatch[envelope.payload.type];
    if (!handler) return;
    await handler(entry, envelope);
  }

  private handleRemoteStreamStopped(
    entry: PeerEntry,
    envelope: DataChannelEnvelopeDto
  ): void {
    entry.remoteStream = null;
    const callbacks = this.deps.getCallbacks();
    callbacks.onRemoteStreamRemoved?.(entry.peerIdSafe);
    callbacks.onDataChannelMessage?.(entry.peerIdSafe, envelope);
  }

  private handlePingMessage(entry: PeerEntry, envelope: DataChannelEnvelopeDto): void {
    if (envelope.payload.type !== 'ping') return;
    this.sendMessage(
      entry.peerIdSafe,
      { type: 'pong', echoSentAt: envelope.payload.sentAt, respondedAt: Date.now() },
      entry.sessionToken
    );

    if (
      this.deps.captureManager.getLocalStream() &&
      entry.initialHandshakeDone &&
      !entry.makingOffer &&
      entry.pc.signalingState === 'stable' &&
      !this.deps.captureManager.hasNegotiatedLocalStream(entry)
    ) {
      this.deps.syncPeerWithLocalStream(entry);
    }

    this.deps.getCallbacks().onDataChannelMessage?.(entry.peerIdSafe, envelope);
  }

  sendMessage<T extends DataChannelPayload>(
    remotePeerIdSafe: string,
    payload: T,
    sessionToken: string
  ): boolean {
    const entry = this.deps.getPeers().get(remotePeerIdSafe);
    if (!entry || entry.sessionToken !== sessionToken) return false;
    if (!entry.dataChannel || entry.dataChannel.readyState !== 'open') return false;

    const envelope: DataChannelEnvelopeDto<T> = {
      version: 1,
      sessionToken,
      senderPeerIdSafe: this.deps.getLocalPeerIdSafe(),
      sentAt: Date.now(),
      payload,
    };

    entry.dataChannel.send(JSON.stringify(envelope));
    return true;
  }

  broadcastMessage<T extends DataChannelPayload>(
    payload: T,
    sessionToken: string
  ): void {
    for (const entry of this.deps.getPeers().values()) {
      const token = entry.sessionToken || sessionToken;
      this.sendMessage(entry.peerIdSafe, payload, token);
    }
  }

  async handleRenegotiation(
    remotePeerIdSafe: string,
    envelope: DataChannelEnvelopeDto
  ): Promise<void> {
    const entry = this.deps.getPeers().get(remotePeerIdSafe);
    if (!entry || entry.sessionToken !== envelope.sessionToken) return;

    const handler = this.dcDispatch[envelope.payload.type];
    if (!handler) return;
    await handler(entry, envelope);
  }

  /** Sends periodic pings over open DataChannels and evicts unhealthy or timed-out peers. */
  pingAndCleanupPeers(): string[] {
    const now = Date.now();
    const evicted: string[] = [];
    const callbacks = this.deps.getCallbacks();

    for (const [peerIdSafe, entry] of Array.from(this.deps.getPeers().entries())) {
      if (!isPeerEntryHealthy(entry)) {
        callbacks.onPeerConnectionError?.(buildConnectionFailure(entry));
        const isIceRestarting =
          (entry.pc.iceConnectionState === 'failed' || entry.pc.connectionState === 'failed') &&
          entry.iceRestartCount < 2 &&
          now - entry.createdAt <= 12000;
        if (isIceRestarting) {
          continue;
        }
        this.deps.closePeer(peerIdSafe);
        evicted.push(peerIdSafe);
        continue;
      }

      if (!entry.initialHandshakeDone && now - entry.createdAt > 12000) {
        callbacks.onPeerConnectionError?.(buildConnectionFailure(entry));
        this.deps.closePeer(peerIdSafe);
        evicted.push(peerIdSafe);
        continue;
      }

      if (!entry.initialHandshakeDone || entry.dataChannel?.readyState !== 'open') {
        continue;
      }

      if (now - entry.lastSeenAt > 4500) {
        entry.missedPingCount += 1;
        if (entry.missedPingCount >= 3) {
          callbacks.onPeerConnectionError?.({
            stage: 'peer_disconnected',
            reason: 'Peer stopped responding to keepalive pings (connection timed out).',
            details: `peer=${peerIdSafe}, missedPings=${entry.missedPingCount}`,
            peerIdSafe,
            timestamp: now,
          });
          this.deps.closePeer(peerIdSafe);
          evicted.push(peerIdSafe);
          continue;
        }
      }

      this.sendMessage(peerIdSafe, { type: 'ping', sentAt: now }, entry.sessionToken);
    }

    return evicted;
  }
}
