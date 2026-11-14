import React from 'react';
import styles from './ConnectionFailureBanner.module.css';
import { ConnectionFailureDto, ConnectionFailureStage } from '../../domain/dtos';

interface ConnectionFailureBannerProps {
  failure: ConnectionFailureDto | null | undefined;
  onRetry?: () => void;
  onDismiss?: () => void;
}

const FAILURE_STAGE_LABELS: Record<ConnectionFailureStage, string> = {
  signaling_broker: 'Signaling Broker',
  sdp_handshake: 'Offer / Answer Handshake',
  ice_negotiation: 'P2P ICE Negotiation',
  peer_disconnected: 'Peer Connection Lost',
  screen_capture: 'Screen Capture',
};

export const ConnectionFailureBanner: React.FC<ConnectionFailureBannerProps> = ({
  failure,
  onRetry,
  onDismiss,
}) => {
  if (!failure) return null;

  return (
    <div className={styles.failureAlertBar} data-testid="connection-failure-alert" role="alert">
      <div className={styles.failureAlertBody}>
        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
          error_outline
        </span>
        <div className={styles.failureAlertCopy}>
          <div className={styles.failureAlertTitle}>
            <span>Connection Failed</span>
            <span className={styles.failureStageBadge} data-testid="connection-failure-stage">
              {FAILURE_STAGE_LABELS[failure.stage]}
            </span>
          </div>
          <p className={styles.failureAlertReason} data-testid="connection-failure-reason">
            {failure.reason}
          </p>
          {failure.details && (
            <p className={styles.failureAlertDetails} data-testid="connection-failure-details">
              {failure.details}
            </p>
          )}
        </div>
      </div>

      <div className={styles.failureAlertActions}>
        {onRetry && (
          <button
            className={styles.failureRetryBtn}
            data-testid="retry-connection-btn"
            onClick={onRetry}
            type="button"
          >
            Reconnect
          </button>
        )}
        {onDismiss && (
          <button
            aria-label="Dismiss connection failure alert"
            className={styles.failureDismissBtn}
            data-testid="dismiss-connection-failure-btn"
            onClick={onDismiss}
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
              close
            </span>
          </button>
        )}
      </div>
    </div>
  );
};

export default ConnectionFailureBanner;
