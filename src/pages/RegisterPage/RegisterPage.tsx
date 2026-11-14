import React from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './RegisterPage.module.css';
import { UserProfile } from '../../domain/dtos';
import { ChooseNickname } from '../../components/ChooseNickname/ChooseNickname';
import { closeRegisterWindowTauri, isTauri } from '../../utils/tauri';
import { useProfile } from '../../hooks/useProfile';

interface RegisterPageProps {
  onRegistered?: (profile: UserProfile) => void;
}

export const RegisterPage: React.FC<RegisterPageProps> = ({ onRegistered }) => {
  const navigate = useNavigate();
  const {
    profile,
    isLoading,
    isRegistered,
    telemetryConsent,
    saveProfile,
    setTelemetryConsent,
  } = useProfile();

  const handleRegistrationComplete = async (savedProfile: UserProfile): Promise<void> => {
    await onRegistered?.(savedProfile);
    if (isTauri()) {
      await closeRegisterWindowTauri();
      return;
    }
    navigate('/');
  };

  const handleCancel = async (): Promise<void> => {
    if (isTauri()) {
      await closeRegisterWindowTauri();
      return;
    }
    navigate('/');
  };

  return (
    <div className={styles.onboardingWrapper}>
      <ChooseNickname
        initialProfile={profile}
        isLoading={isLoading}
        isRegistered={isRegistered}
        telemetryConsent={telemetryConsent}
        onSaveProfile={saveProfile}
        onChangeTelemetryConsent={setTelemetryConsent}
        onCompleteRegistration={handleRegistrationComplete}
        onCancel={() => void handleCancel()}
      />
    </div>
  );
};

export default RegisterPage;
