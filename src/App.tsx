import React, { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { isTauri, showRegisterWindowTauri } from './utils/tauri';

export const App: React.FC = () => {
  const [isRegistered, setIsRegistered] = useState(() => {
    return Boolean(localStorage.getItem('elfy_user_registered'));
  });

  // On first access in Tauri main window: trigger the standalone registration window
  useEffect(() => {
    if (!isRegistered && isTauri() && (window.location.hash === '#/' || window.location.hash === '')) {
      showRegisterWindowTauri().catch(console.error);
    }
  }, [isRegistered]);

  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'elfy_user_registered') {
        setIsRegistered(Boolean(e.newValue));
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  return <Outlet />;
};

export default App;
