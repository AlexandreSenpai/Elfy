import React from 'react';
import styles from './TelemetryConsentModal.module.css';

interface TelemetryConsentModalProps {
  isOpen: boolean;
  isSubmitting?: boolean;
  onAgree: () => void | Promise<void>;
  onDecline: () => void | Promise<void>;
}

export const TelemetryConsentModal: React.FC<TelemetryConsentModalProps> = ({
  isOpen,
  isSubmitting = false,
  onAgree,
  onDecline
}) => {
  if (!isOpen) return null;

  return (
    <div
      className={styles.backdrop}
      data-testid="telemetry-consent-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="telemetry-consent-title"
    >
      <div className={styles.modalCard}>
        <div className={styles.glowAccent} />

        <div className={styles.headerRow}>
          <div className={styles.iconWrap}>
            <span className="material-symbols-outlined" style={{ fontSize: '24px' }}>
              monitoring
            </span>
          </div>
          <div className={styles.titleBlock}>
            <span className={styles.eyebrow}>Privacy &amp; Diagnostics</span>
            <h2 id="telemetry-consent-title" className={styles.title}>
              Anonymous Performance Telemetry
            </h2>
          </div>
        </div>

        <p className={styles.description}>
          Help Elfy keep screen sharing smooth across hardware tiers. With your consent, we collect
          only anonymous machine and streaming performance metrics to diagnose frame drops.
        </p>

        <div className={styles.pillars}>
          <div className={styles.pillarAllowed}>
            <span className={`material-symbols-outlined ${styles.allowedIcon}`}>check_circle</span>
            <div className={styles.pillarText}>
              <strong>Collected (if agreed):</strong> Stream FPS (30/60), connection latency, and
              anonymous CPU/RAM load tier.
            </div>
          </div>

          <div className={styles.pillarBlocked}>
            <span className={`material-symbols-outlined ${styles.blockedIcon}`}>shield_lock</span>
            <div className={styles.pillarText}>
              <strong>Never collected:</strong> Nicknames, peer tags, room codes, friend hubs, IP
              addresses, or screen contents.
            </div>
          </div>
        </div>

        <p className={styles.footerNote}>
          You can opt in or opt out anytime inside Persona &amp; Settings.
        </p>

        <div className={styles.actions}>
          <button
            className={styles.declineBtn}
            data-testid="telemetry-decline-btn"
            disabled={isSubmitting}
            onClick={() => void onDecline()}
            type="button"
          >
            Decline
          </button>
          <button
            className={styles.agreeBtn}
            data-testid="telemetry-agree-btn"
            disabled={isSubmitting}
            onClick={() => void onAgree()}
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
              verified_user
            </span>
            <span>Agree &amp; Continue</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default TelemetryConsentModal;
