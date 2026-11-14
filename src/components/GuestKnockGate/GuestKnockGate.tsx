import React from 'react';
import styles from './GuestKnockGate.module.css';
import { KnockStatus } from '../../domain/dtos';

interface GuestKnockGateProps {
  hubId: string;
  hostName?: string;
  status: KnockStatus;
  errorMessage?: string | null;
  onRetry: () => void;
  onCancel: () => void;
  onLeave?: () => void;
}

interface GateStateCopy {
  icon: string;
  title: string;
  describe: (hostName: string, hubId: string, errorMessage?: string | null) => string;
}

const GATE_STATE_COPY: Record<KnockStatus, GateStateCopy> = {
  knocking: {
    icon: 'door_front',
    title: 'Waiting for Approval',
    describe: (hostName, hubId) =>
      `${hostName} needs to accept your entrance before you can join ${hubId}.`,
  },
  accepted: {
    icon: 'lock_open',
    title: 'Entrance Accepted!',
    describe: (hostName) => `${hostName} approved your entrance. Door unlocked!`,
  },
  rejected: {
    icon: 'do_not_disturb',
    title: 'Entrance Declined',
    describe: (hostName, _hubId, err) =>
      err || `${hostName} declined your entrance request.`,
  },
  timeout: {
    icon: 'hourglass_empty',
    title: 'No Response from Host',
    describe: (hostName) => `${hostName} didn't respond in time.`,
  },
  idle: {
    icon: 'front_hand',
    title: 'Knock to Enter',
    describe: (_hostName, hubId) => `Click knock to request entrance to ${hubId}.`,
  },
};

export const GuestKnockGate: React.FC<GuestKnockGateProps> = ({
  hubId,
  hostName = 'Hub Owner',
  status,
  errorMessage,
  onRetry,
  onCancel,
  onLeave,
}) => {
  const copy = GATE_STATE_COPY[status];
  const canRetry = status === 'rejected' || status === 'timeout' || status === 'idle';

  return (
    <div className={styles.gateCard} data-testid="guest-knock-gate">
      <div className={styles.iconCircle}>
        <span className="material-symbols-outlined" style={{ fontSize: '32px' }}>
          {copy.icon}
        </span>
      </div>

      <h2 className={styles.title}>{copy.title}</h2>
      <p className={styles.description}>{copy.describe(hostName, hubId, errorMessage)}</p>

      <div className={styles.actions}>
        {status === 'knocking' && (
          <button className={styles.btnSecondary} onClick={onCancel} type="button">
            Cancel
          </button>
        )}
        {canRetry && (
          <button className={styles.btnPrimary} onClick={onRetry} type="button">
            Knock Again
          </button>
        )}
        {onLeave && (
          <button className={styles.btnSecondary} onClick={onLeave} type="button">
            Back to Hubs
          </button>
        )}
      </div>
    </div>
  );
};

export default GuestKnockGate;
