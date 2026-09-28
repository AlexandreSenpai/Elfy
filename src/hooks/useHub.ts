import { useState, useEffect } from 'react';
import { UserProfile } from '../types';

export const useHub = (hubId: string, profile: UserProfile) => {
  const [currentHubId, setCurrentHubId] = useState<string>(hubId);

  useEffect(() => {
    if (hubId) {
      setCurrentHubId(hubId);
    }
  }, [hubId]);

  return {
    currentHubId,
    profile
  };
};

export default useHub;