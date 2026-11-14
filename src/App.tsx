import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { TelemetryConsentModal } from './components/TelemetryConsentModal/TelemetryConsentModal';
import { useProfile } from './hooks/useProfile';
import { TelemetryConsentState } from './domain/dtos';
import { isTauri, showRegisterWindowTauri } from './utils/tauri';

export const App: React.FC = () => {
  const { isLoading, isRegistered, telemetryConsent, setTelemetryConsent } = useProfile();
  const [isUpdatingConsent, setIsUpdatingConsent] = useState(false);

  useEffect(() => {
    if (isLoading || isRegistered || !isTauri()) return;
    const isMainHash = window.location.hash === '#/' || window.location.hash === '';
    if (!isMainHash) return;
    showRegisterWindowTauri().catch(console.error);
  }, [isLoading, isRegistered]);

  const handleConsentDecision = async (decision: TelemetryConsentState): Promise<void> => {
    if (isUpdatingConsent) return;
    setIsUpdatingConsent(true);
    try {
      await setTelemetryConsent(decision);
    } finally {
      setIsUpdatingConsent(false);
    }
  };

  const shouldShowConsentModal = !isLoading && telemetryConsent === 'unset';

  return (
    <>
      <Outlet />
      <TelemetryConsentModal
        isOpen={shouldShowConsentModal}
        isSubmitting={isUpdatingConsent}
        onAgree={() => handleConsentDecision('granted')}
        onDecline={() => handleConsentDecision('denied')}
      />
    </>
  );
};

export default App;
