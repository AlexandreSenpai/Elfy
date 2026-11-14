import { TELEMETRY_CONFIG } from '../domain/config';
import {
  TelemetryConsentState,
  TelemetryEventDto,
  TelemetryEventName,
  TelemetryEventParams,
} from '../domain/dtos';
import { ITelemetryProvider } from '../ports';

interface TelemetryTestWindow extends Window {
  __ELFY_TELEMETRY_EVENTS__?: TelemetryEventDto[];
}

const MAX_RECORDED_EVENTS = 200;

const createAnonymousSessionId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `anon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const sanitizeTelemetryParams = (params?: TelemetryEventParams): TelemetryEventParams => {
  if (!params) return {};
  const clean: TelemetryEventParams = {};
  if (params.role === 'owner' || params.role === 'guest') clean.role = params.role;
  if (params.fps === 30 || params.fps === 60) clean.fps = params.fps;
  if (typeof params.peerCountTier === 'string') clean.peerCountTier = params.peerCountTier;
  if (typeof params.cpuTier === 'string') clean.cpuTier = params.cpuTier;
  if (typeof params.ramTier === 'string') clean.ramTier = params.ramTier;
  if (typeof params.rttBucket === 'string') clean.rttBucket = params.rttBucket;
  return clean;
};

const syncWindowEvents = (events: TelemetryEventDto[]): void => {
  if (typeof window === 'undefined') return;
  (window as TelemetryTestWindow).__ELFY_TELEMETRY_EVENTS__ = [...events];
};

/**
 * Consent-gated Google Analytics 4 Measurement Protocol adapter.
 * Strictly blocks all events until consent === 'granted' and strips any PII.
 */
export class TelemetryAdapter implements ITelemetryProvider {
  private consent: TelemetryConsentState = 'unset';
  private sessionClientId = createAnonymousSessionId();
  private recordedEvents: TelemetryEventDto[] = [];

  constructor() {
    syncWindowEvents(this.recordedEvents);
  }

  setConsent(consent: TelemetryConsentState): void {
    this.consent = consent;
  }

  getConsent(): TelemetryConsentState {
    return this.consent;
  }

  async trackEvent(
    name: TelemetryEventName,
    params?: TelemetryEventParams
  ): Promise<boolean> {
    if (this.consent !== 'granted') return false;

    const cleanParams = sanitizeTelemetryParams(params);
    const eventDto: TelemetryEventDto = {
      name,
      params: cleanParams,
      timestamp: Date.now(),
    };

    this.recordedEvents.push(eventDto);
    if (this.recordedEvents.length > MAX_RECORDED_EVENTS) {
      this.recordedEvents.shift();
    }
    syncWindowEvents(this.recordedEvents);

    const url =
      `${TELEMETRY_CONFIG.ENDPOINT}` +
      `?measurement_id=${encodeURIComponent(TELEMETRY_CONFIG.GA_MEASUREMENT_ID)}` +
      `&api_secret=${encodeURIComponent(TELEMETRY_CONFIG.GA_API_SECRET)}`;

    if (typeof fetch === 'undefined') return true;

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          client_id: this.sessionClientId,
          events: [{ name: eventDto.name, params: eventDto.params }],
        }),
      });
    } catch {
      // Offline or blocked analytics endpoints must never impact user flow.
    }

    return true;
  }

  getRecordedEventsForTesting(): TelemetryEventDto[] {
    return [...this.recordedEvents];
  }

  clearRecordedEventsForTesting(): void {
    this.recordedEvents = [];
    syncWindowEvents([]);
  }
}

export const telemetryAdapter: ITelemetryProvider = new TelemetryAdapter();
