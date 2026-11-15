import { SIGNALING_CONFIG } from '../../domain/config';
import { StreamEngineCallbacks } from '../../ports';
import { getRtcConfiguration } from '../../utils/stun';
import { CaptureManager } from './captureManager';
import { applyPreferredVideoCodecs } from './codecSelector';
import { DataChannelRouter } from './dataChannelRouter';
import { applyVideoBitrateHintsToSdp } from './sdpBitrate';
import {
  PeerEntry,
  buildConnectionFailure,
  buildFreshRemoteStream,
  clearDisconnectTimer,
  clearOfferTimeoutTimer,
  detachAndClosePeerEntry,
  enqueuePeerTask,
  isDataChannelTransportHealthy,
  isPeerEntryHealthy,
  isPolitePeer,
  touchPeerActivity,
} from './peerTypes';

export interface PeerNegotiatorDeps {
  getLocalPeerIdSafe: () => string;
  getCallbacks: () => StreamEngineCallbacks;
  getPeers: () => Map<string, PeerEntry>;
  getExpectedTokens: () => Map<string, string>;
  captureManager: CaptureManager;
  getDataChannelRouter: () => DataChannelRouter;
}

const isPeerClosedOrFailed = (pc: RTCPeerConnection): boolean => {
  return pc.connectionState === 'closed' || pc.connectionState === 'failed';
};

/**
 * Manages RTCPeerConnection lifecycle, SDP offer/answer negotiation with perfect
 * negotiation collision resolution, ICE buffering/restart, and remote track binding.
 */
export class PeerNegotiator {
  constructor(private readonly deps: PeerNegotiatorDeps) {}

  registerPeerSessionToken(remotePeerIdSafe: string, sessionToken: string): void {
    if (!remotePeerIdSafe || !sessionToken) return;
    const existing = this.deps.getPeers().get(remotePeerIdSafe);
    if (existing && existing.sessionToken !== sessionToken) {
      this.closePeer(remotePeerIdSafe);
    }
    this.deps.getExpectedTokens().set(remotePeerIdSafe, sessionToken);
  }

  private getOrCreatePeerEntry(remotePeerIdSafe: string, sessionToken: string): PeerEntry {
    const peers = this.deps.getPeers();
    const existing = peers.get(remotePeerIdSafe);
    const isReusable =
      existing &&
      existing.sessionToken === sessionToken &&
      isPeerEntryHealthy(existing);

    if (isReusable) {
      return existing;
    }

    if (existing) {
      peers.delete(remotePeerIdSafe);
      detachAndClosePeerEntry(existing);
    }

    const now = Date.now();
    const pc = new RTCPeerConnection(getRtcConfiguration());
    const entry: PeerEntry = {
      peerIdSafe: remotePeerIdSafe,
      pc,
      dataChannel: null,
      pendingIce: [],
      pendingLocalIce: [],
      canEmitIce: true,
      signalingChain: Promise.resolve(),
      iceRestartCount: 0,
      receivedRemoteIceCount: 0,
      disconnectTimer: null,
      offerTimeoutTimer: null,
      createdAt: now,
      lastSeenAt: now,
      missedPingCount: 0,
      sessionToken,
      makingOffer: false,
      ignoreOffer: false,
      initialHandshakeDone: false,
      pendingRenegotiation: false,
      remoteStream: null,
    };

    this.bindPeerEvents(entry);
    peers.set(remotePeerIdSafe, entry);
    return entry;
  }

  private bindPeerEvents(entry: PeerEntry): void {
    const peers = this.deps.getPeers();

    entry.pc.onicecandidate = (event) => {
      if (peers.get(entry.peerIdSafe) !== entry || !event.candidate) return;
      this.emitIceCandidate(entry, event.candidate.toJSON());
    };

    entry.pc.ontrack = (event) => {
      if (peers.get(entry.peerIdSafe) !== entry) return;
      this.handleRemoteTrack(entry, event);
    };

    entry.pc.ondatachannel = (event) => {
      if (peers.get(entry.peerIdSafe) !== entry) return;
      if (event.channel.label !== SIGNALING_CONFIG.DATA_CHANNEL_LABEL) return;
      this.deps.getDataChannelRouter().attachDataChannel(entry, event.channel);
    };

    entry.pc.onsignalingstatechange = () => {
      if (peers.get(entry.peerIdSafe) !== entry) return;
      if (entry.pc.signalingState === 'stable' && entry.pendingRenegotiation) {
        entry.pendingRenegotiation = false;
        void this.renegotiatePeer(entry.peerIdSafe);
      }
    };

    entry.pc.oniceconnectionstatechange = () => {
      if (peers.get(entry.peerIdSafe) !== entry) return;
      const iceState = entry.pc.iceConnectionState;
      if (iceState === 'connected' || iceState === 'completed') {
        clearDisconnectTimer(entry);
        entry.iceRestartCount = 0;
        return;
      }
      if (iceState === 'disconnected' && entry.pc.connectionState !== 'closed') {
        if (entry.disconnectTimer !== null) return;
        entry.disconnectTimer = window.setTimeout(() => {
          entry.disconnectTimer = null;
          if (peers.get(entry.peerIdSafe) !== entry) return;
          if (entry.pc.iceConnectionState !== 'disconnected') return;
          this.triggerIceRestart(entry);
        }, 3500);
        return;
      }
      if (iceState !== 'failed') return;
      clearDisconnectTimer(entry);
      if (entry.iceRestartCount >= 2) {
        if (entry.pc.connectionState === 'failed') {
          this.handleConnectionStateChange(entry);
        }
        return;
      }
      this.triggerIceRestart(entry);
    };

    entry.pc.onconnectionstatechange = () => {
      if (peers.get(entry.peerIdSafe) !== entry) return;
      this.handleConnectionStateChange(entry);
    };
  }

  private scheduleOfferTimeout(entry: PeerEntry): void {
    clearOfferTimeoutTimer(entry);
    entry.offerTimeoutTimer = window.setTimeout(() => {
      entry.offerTimeoutTimer = null;
      if (this.deps.getPeers().get(entry.peerIdSafe) !== entry) return;
      if (entry.pc.connectionState === 'closed' || entry.initialHandshakeDone) return;

      const callbacks = this.deps.getCallbacks();
      if (entry.pc.signalingState === 'have-local-offer' && entry.pc.localDescription) {
        void callbacks.onSignalOffer?.(
          entry.peerIdSafe,
          entry.pc.localDescription.toJSON(),
          entry.sessionToken
        );
      }

      entry.offerTimeoutTimer = window.setTimeout(() => {
        entry.offerTimeoutTimer = null;
        if (this.deps.getPeers().get(entry.peerIdSafe) !== entry) return;
        if (entry.pc.connectionState === 'closed' || entry.initialHandshakeDone) return;

        if (entry.pc.signalingState === 'have-local-offer') {
          callbacks.onPeerConnectionError?.({
            stage: 'sdp_handshake',
            reason: 'Peer did not answer the WebRTC offer in time (SDP handshake timed out).',
            details: `peer=${entry.peerIdSafe}, signalingState=${entry.pc.signalingState}, iceGatheringState=${entry.pc.iceGatheringState}`,
            peerIdSafe: entry.peerIdSafe,
            timestamp: Date.now(),
          });
          return;
        }

        callbacks.onPeerConnectionError?.(buildConnectionFailure(entry));
      }, 5500);
    }, 3500);
  }

  private triggerIceRestart(entry: PeerEntry): void {
    if (entry.pc.connectionState === 'closed' || entry.iceRestartCount >= 2) return;
    entry.iceRestartCount += 1;
    if (typeof entry.pc.restartIce === 'function') {
      entry.pc.restartIce();
    }
    void this.renegotiatePeer(entry.peerIdSafe);
  }

  private dispatchLocalIceCandidate(entry: PeerEntry, candidate: RTCIceCandidateInit): void {
    if (isDataChannelTransportHealthy(entry)) {
      this.deps.getDataChannelRouter().sendMessage(
        entry.peerIdSafe,
        {
          type: 'renegotiate_ice',
          fromPeerIdSafe: this.deps.getLocalPeerIdSafe(),
          candidate,
        },
        entry.sessionToken
      );
      return;
    }

    void this.deps.getCallbacks().onSignalIce?.(entry.peerIdSafe, candidate, entry.sessionToken);
  }

  private emitIceCandidate(entry: PeerEntry, candidate: RTCIceCandidateInit): void {
    if (!entry.canEmitIce) {
      entry.pendingLocalIce.push(candidate);
      return;
    }
    this.dispatchLocalIceCandidate(entry, candidate);
  }

  private flushPendingLocalIce(entry: PeerEntry): void {
    if (!entry.canEmitIce) return;
    const buffered = entry.pendingLocalIce.splice(0, entry.pendingLocalIce.length);
    for (const candidate of buffered) {
      this.dispatchLocalIceCandidate(entry, candidate);
    }
  }

  private async addIceSafely(
    pc: RTCPeerConnection,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    if (pc.connectionState === 'closed') return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[WebRTC] Ignored ICE candidate error:', err);
    }
  }

  private async flushPendingIce(entry: PeerEntry): Promise<void> {
    if (!entry.pc.remoteDescription) return;
    const buffered = entry.pendingIce.splice(0, entry.pendingIce.length);
    for (const candidate of buffered) {
      await this.addIceSafely(entry.pc, candidate);
    }
  }

  private handleRemoteTrack(entry: PeerEntry, event: RTCTrackEvent): void {
    touchPeerActivity(entry);
    const stream = buildFreshRemoteStream(entry, event.track);
    if (!stream) return;

    entry.remoteStream = stream;
    this.deps.getCallbacks().onRemoteStream?.(entry.peerIdSafe, stream);

    event.track.onunmute = () => {
      if (this.deps.getPeers().get(entry.peerIdSafe) !== entry) return;
      if (entry.pc.connectionState === 'closed' || event.track.readyState === 'ended') return;
      const unmutedStream = buildFreshRemoteStream(entry, event.track);
      if (!unmutedStream) return;
      entry.remoteStream = unmutedStream;
      this.deps.getCallbacks().onRemoteStream?.(entry.peerIdSafe, unmutedStream);
    };
  }

  private handleConnectionStateChange(entry: PeerEntry): void {
    const state = entry.pc.connectionState;
    const callbacks = this.deps.getCallbacks();
    callbacks.onPeerConnectionStateChange?.(entry.peerIdSafe, state);

    if (state === 'failed') {
      callbacks.onPeerConnectionError?.(buildConnectionFailure(entry));
    }

    const shouldEvict = state === 'closed' || (state === 'failed' && entry.iceRestartCount >= 2);
    if (!shouldEvict) return;

    entry.remoteStream = null;
    if (this.deps.getPeers().get(entry.peerIdSafe) === entry) {
      this.deps.getPeers().delete(entry.peerIdSafe);
      detachAndClosePeerEntry(entry);
    }
    callbacks.onRemoteStreamRemoved?.(entry.peerIdSafe);
  }

  private ensureLocalSendersNegotiated(entry: PeerEntry): void {
    if (!this.deps.captureManager.getLocalStream()) return;
    const hasUnnegotiatedSender = entry.pc
      .getTransceivers()
      .some(
        (t) =>
          t.direction !== 'stopped' &&
          t.currentDirection !== 'stopped' &&
          t.sender.track !== null &&
          t.currentDirection !== 'sendrecv' &&
          t.currentDirection !== 'sendonly'
      );
    if (!hasUnnegotiatedSender) return;
    entry.pendingRenegotiation = true;
    void this.renegotiatePeer(entry.peerIdSafe);
  }

  syncPeerWithLocalStream(entry: PeerEntry): void {
    const stream = this.deps.captureManager.getLocalStream();
    if (!stream || entry.pc.connectionState === 'closed') return;
    if (!stream.getTracks().some((t) => t.readyState === 'live')) return;

    void enqueuePeerTask(this.deps.getPeers(), entry, async () => {
      const liveStream = this.deps.captureManager.getLocalStream();
      if (!liveStream || entry.pc.connectionState === 'closed') return;
      if (!liveStream.getTracks().some((t) => t.readyState === 'live')) return;
      await this.deps.captureManager.attachLocalTracksToPeer(entry, liveStream);
      void this.renegotiatePeer(entry.peerIdSafe);
    });
  }

  private async createAndSendOffer(entry: PeerEntry, preferDataChannel: boolean): Promise<void> {
    entry.makingOffer = true;
    entry.canEmitIce = false;
    try {
      await applyPreferredVideoCodecs(entry.pc);
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      await this.deps.captureManager.applyEncodingToPeerSenders(
        entry,
        this.deps.getPeers().size
      );

      if (entry.pc.localDescription) {
        const sdp = entry.pc.localDescription.toJSON();
        const sentOverDc =
          preferDataChannel &&
          isDataChannelTransportHealthy(entry) &&
          this.deps.getDataChannelRouter().sendMessage(
            entry.peerIdSafe,
            {
              type: 'renegotiate_offer',
              fromPeerIdSafe: this.deps.getLocalPeerIdSafe(),
              sdp,
            },
            entry.sessionToken
          );

        if (!sentOverDc) {
          await this.deps.getCallbacks().onSignalOffer?.(entry.peerIdSafe, sdp, entry.sessionToken);
        }
      }

      entry.canEmitIce = true;
      this.flushPendingLocalIce(entry);
      this.scheduleOfferTimeout(entry);
    } finally {
      entry.makingOffer = false;
      entry.canEmitIce = true;
      if (entry.pc.localDescription) {
        this.flushPendingLocalIce(entry);
      }
    }
  }

  async initiatePeerConnection(remotePeerIdSafe: string, sessionToken: string): Promise<void> {
    if (!remotePeerIdSafe || !sessionToken) return;
    const peers = this.deps.getPeers();
    const prev = peers.get(remotePeerIdSafe);
    if (prev) {
      peers.delete(remotePeerIdSafe);
      detachAndClosePeerEntry(prev);
    }
    this.deps.getExpectedTokens().set(remotePeerIdSafe, sessionToken);
    const entry = this.getOrCreatePeerEntry(remotePeerIdSafe, sessionToken);

    return enqueuePeerTask(peers, entry, async () => {
      if (!entry.dataChannel) {
        const dc = entry.pc.createDataChannel(SIGNALING_CONFIG.DATA_CHANNEL_LABEL, {
          ordered: true,
        });
        this.deps.getDataChannelRouter().attachDataChannel(entry, dc);
      }

      if (this.deps.captureManager.getLocalStream()) {
        await this.deps.captureManager.attachLocalTracksToPeer(entry);
        await this.deps.captureManager.refreshAllPeerSenders(this.deps.getPeers().values());
      }

      await this.createAndSendOffer(entry, false);
    });
  }

  async handleIncomingOffer(
    remotePeerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ): Promise<void> {
    const expected = this.deps.getExpectedTokens().get(remotePeerIdSafe);
    if (!expected || expected !== sessionToken) return;

    const entry = this.getOrCreatePeerEntry(remotePeerIdSafe, sessionToken);
    if (entry.sessionToken !== sessionToken) return;
    return this.applyRemoteOffer(entry, sdp, false);
  }

  private async setRemoteDescriptionWithBitrateHints(
    entry: PeerEntry,
    sdp: RTCSessionDescriptionInit
  ): Promise<void> {
    const rawSdp = sdp.sdp;
    if (!rawSdp || !this.deps.captureManager.hasActiveLocalVideo()) {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      return;
    }

    const hints = this.deps.captureManager.getVideoBitrateHints(
      this.deps.getPeers().size
    );
    const decoratedSdp = applyVideoBitrateHintsToSdp(rawSdp, hints);
    if (decoratedSdp === rawSdp) {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      return;
    }

    try {
      await entry.pc.setRemoteDescription(
        new RTCSessionDescription({ ...sdp, sdp: decoratedSdp })
      );
    } catch {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }
  }

  async applyRemoteOffer(
    entry: PeerEntry,
    sdp: RTCSessionDescriptionInit,
    preferDataChannel: boolean
  ): Promise<void> {
    return enqueuePeerTask(this.deps.getPeers(), entry, async () => {
      const collision = entry.makingOffer || entry.pc.signalingState !== 'stable';
      const polite = isPolitePeer(this.deps.getLocalPeerIdSafe(), entry.peerIdSafe);
      entry.ignoreOffer = collision && !polite;
      if (entry.ignoreOffer) return;

      if (collision && polite) {
        await entry.pc.setLocalDescription({ type: 'rollback' });
      }

      await this.setRemoteDescriptionWithBitrateHints(entry, sdp);
      await this.flushPendingIce(entry);

      if (this.deps.captureManager.getLocalStream()) {
        await this.deps.captureManager.attachLocalTracksToPeer(entry);
      }

      entry.canEmitIce = false;
      try {
        await applyPreferredVideoCodecs(entry.pc);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        await this.deps.captureManager.applyEncodingToPeerSenders(
          entry,
          this.deps.getPeers().size
        );

        if (entry.pc.localDescription) {
          const answerSdp = entry.pc.localDescription.toJSON();
          const sentOverDc =
            preferDataChannel &&
            isDataChannelTransportHealthy(entry) &&
            this.deps.getDataChannelRouter().sendMessage(
              entry.peerIdSafe,
              {
                type: 'renegotiate_answer',
                fromPeerIdSafe: this.deps.getLocalPeerIdSafe(),
                sdp: answerSdp,
              },
              entry.sessionToken
            );

          if (!sentOverDc) {
            await this.deps.getCallbacks().onSignalAnswer?.(
              entry.peerIdSafe,
              answerSdp,
              entry.sessionToken
            );
          }
        }

        entry.canEmitIce = true;
        this.flushPendingLocalIce(entry);
        if (!preferDataChannel && !entry.initialHandshakeDone) {
          this.scheduleOfferTimeout(entry);
        }
      } finally {
        entry.canEmitIce = true;
        if (entry.pc.localDescription) {
          this.flushPendingLocalIce(entry);
        }
      }

      this.ensureLocalSendersNegotiated(entry);
    });
  }

  async handleIncomingAnswer(
    remotePeerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ): Promise<void> {
    const entry = this.deps.getPeers().get(remotePeerIdSafe);
    if (!entry || entry.sessionToken !== sessionToken) return;
    return this.applyRemoteAnswer(entry, sdp);
  }

  async applyRemoteAnswer(entry: PeerEntry, sdp: RTCSessionDescriptionInit): Promise<void> {
    return enqueuePeerTask(this.deps.getPeers(), entry, async () => {
      if (entry.pc.signalingState !== 'have-local-offer') return;
      touchPeerActivity(entry);
      clearOfferTimeoutTimer(entry);
      await this.setRemoteDescriptionWithBitrateHints(entry, sdp);
      await this.deps.captureManager.applyEncodingToPeerSenders(
        entry,
        this.deps.getPeers().size
      );
      await this.flushPendingIce(entry);
    });
  }

  async handleIncomingIce(
    remotePeerIdSafe: string,
    candidate: RTCIceCandidateInit,
    sessionToken: string
  ): Promise<void> {
    const expected = this.deps.getExpectedTokens().get(remotePeerIdSafe);
    if (!expected || expected !== sessionToken) return;

    const entry = this.getOrCreatePeerEntry(remotePeerIdSafe, sessionToken);
    if (entry.sessionToken !== sessionToken) return;
    return this.applyRemoteIce(entry, candidate);
  }

  async applyRemoteIce(entry: PeerEntry, candidate: RTCIceCandidateInit): Promise<void> {
    return enqueuePeerTask(this.deps.getPeers(), entry, async () => {
      touchPeerActivity(entry);
      entry.receivedRemoteIceCount += 1;
      if (!entry.pc.remoteDescription) {
        entry.pendingIce.push(candidate);
        return;
      }
      await this.addIceSafely(entry.pc, candidate);
    });
  }

  async renegotiatePeer(remotePeerIdSafe: string): Promise<void> {
    const peers = this.deps.getPeers();
    const entry = peers.get(remotePeerIdSafe);
    if (!entry || entry.pc.connectionState === 'closed') return;

    return enqueuePeerTask(peers, entry, async () => {
      if (entry.pc.connectionState === 'closed') return;
      if (entry.makingOffer || entry.pc.signalingState !== 'stable') {
        entry.pendingRenegotiation = true;
        return;
      }

      entry.pendingRenegotiation = false;
      try {
        await this.createAndSendOffer(entry, true);
      } catch (err) {
        if (isPeerClosedOrFailed(entry.pc) || peers.get(remotePeerIdSafe) !== entry) {
          return;
        }
        throw err;
      }
    });
  }

  async renegotiateAllPeers(): Promise<void> {
    for (const peerId of Array.from(this.deps.getPeers().keys())) {
      await this.renegotiatePeer(peerId);
    }
  }

  closePeer(remotePeerIdSafe: string): void {
    this.deps.getExpectedTokens().delete(remotePeerIdSafe);
    const entry = this.deps.getPeers().get(remotePeerIdSafe);
    if (!entry) return;

    this.deps.getPeers().delete(remotePeerIdSafe);
    detachAndClosePeerEntry(entry);
    this.deps.getCallbacks().onRemoteStreamRemoved?.(remotePeerIdSafe);
    void this.deps.captureManager.refreshAllPeerSenders(this.deps.getPeers().values());
  }

  closeAllPeers(): void {
    for (const peerId of Array.from(this.deps.getPeers().keys())) {
      this.closePeer(peerId);
    }
    this.deps.getExpectedTokens().clear();
  }
}
