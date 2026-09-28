import React from 'react';
import styles from './HostKnockAlert.module.css';
import { PendingKnock } from '../../types/knock';

interface HostKnockAlertProps {
  pendingKnocks: PendingKnock[];
  onAccept: (knock: PendingKnock) => void;
  onReject: (knock: PendingKnock) => void;
}

export const HostKnockAlert: React.FC<HostKnockAlertProps> = ({
  pendingKnocks,
  onAccept,
  onReject
}) => {
  if (pendingKnocks.length === 0) return null;

  return (
    <div className={styles.overlay}>
      {pendingKnocks.map((knock) => (
        <div key={knock.id} className={styles.alertCard}>
          <div className={styles.info}>
            <span className={styles.badge}>Knock Request</span>
            <div className={styles.name}>
              <strong>{knock.displayName}</strong> ({knock.peerTag}) wants to join
            </div>
          </div>
          <div className={styles.actions}>
            <button className={styles.allowBtn} onClick={() => onAccept(knock)} type="button">
              Allow
            </button>
            <button className={styles.declineBtn} onClick={() => onReject(knock)} type="button">
              Decline
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

export default HostKnockAlert;
