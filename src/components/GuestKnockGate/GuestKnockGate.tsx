import React from 'react';
import styles from './GuestKnockGate.module.css';
import { KnockStatus } from '../../types/knock';

interface GuestKnockGateProps {
  hubId: string;
  hostName?: string;
  status: KnockStatus;
  onRetry: () => void;
  onCancel: () => void;
}

export const GuestKnockGate: React.FC<GuestKnockGateProps> = ({
  hubId,
  hostName = 'Hub Owner',
  status,
  onRetry,
  onCancel
}) => {
  return (
    <div className={styles.gateCard}>
      <div className={styles.iconCircle}>
        <span className="material-symbols-outlined" style={{ fontSize: '32px' }}>
          {status === 'knocking' && 'door_front'}
          {status === 'accepted' && 'lock_open'}
          {status === 'rejected' && 'do_not_disturb'}
          {status === 'timeout' && 'hourglass_empty'}
          {status === 'idle' && 'front_hand'}
        </span>
      </div>

      <h2 className={styles.title}>
        {status === 'knocking' && 'Waiting for Approval'}
        {status === 'accepted' && 'Entrance Accepted!'}
        {status === 'rejected' && 'Entrance Declined'}
        {status === 'timeout' && 'No Response from Host'}
        {status === 'idle' && 'Knock to Enter'}
      </h2>

      <p className={styles.description}>
        {status === 'knocking' && `${hostName} needs to accept your entrance before you can join ${hubId}.`}
        {status === 'accepted' && `${hostName} approved your entrance. Door unlocked!`}
        {status === 'rejected' && `${hostName} declined your entrance request.`}
        {status === 'timeout' && `${hostName} didn't respond in time.`}
        {status === 'idle' && `Click knock to request entrance to ${hubId}.`}
      </p>

      <div className={styles.actions}>
        {status === 'knocking' && (
          <button className={styles.btnSecondary} onClick={onCancel} type="button">
            Cancel
          </button>
        )}
        {(status === 'rejected' || status === 'timeout' || status === 'idle') && (
          <button className={styles.btnPrimary} onClick={onRetry} type="button">
            Knock Again
          </button>
        )}
      </div>
    </div>
  );
};

export default GuestKnockGate;
