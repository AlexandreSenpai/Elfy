import React from 'react';
import styles from './RegisterPage.module.css';
import { UserProfile } from '../../types';
import { ChooseNickname } from '../../components/ChooseNickname/ChooseNickname';
import { closeRegisterWindowTauri, isTauri } from '../../utils/tauri';
import { useProfile } from '../../hooks/useProfile';

interface RegisterPageProps {
  onRegistered?: (profile: UserProfile) => void;
}

export const RegisterPage: React.FC<RegisterPageProps> = ({ onRegistered }) => {
  const { profile, saveProfile } = useProfile();

  const handleRegistrationComplete = async (newProfile: UserProfile) => {
    saveProfile(newProfile);
    
    if (onRegistered) {
      onRegistered(newProfile);
    }

    if (isTauri()) {
      await closeRegisterWindowTauri();
    }
  };

  return (
    <div className={styles.onboardingWrapper}>
      <ChooseNickname
        initialProfile={profile}
        onCompleteRegistration={handleRegistrationComplete}
      />
    </div>
  );
};

export default RegisterPage;
