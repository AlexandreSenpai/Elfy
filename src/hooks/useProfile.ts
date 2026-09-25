import { useState, useEffect } from 'react';
import { UserProfile } from '../types';
import { DEFAULT_USER_PROFILE } from '../data/mockData';
import { db, IUsers } from '../database';
import { commands } from '@skipperndt/plugin-machine-uid';

export const useProfile = () => {
  const [profile, setProfile] = useState<UserProfile>(() => {
    const saved = localStorage.getItem('elfy_user_profile');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return DEFAULT_USER_PROFILE;
      }
    }
    return DEFAULT_USER_PROFILE;
  });

  // Sync from Dexie database on startup if existing user
  useEffect(() => {
    const loadFromDb = async () => {
      try {
        const machine = await commands.getMachineUid();
        if (machine.status === 'ok' && machine.data.id) {
          const user = await db.table<IUsers>('users').get(machine.data.id);
          if (user) {
            const loadedProfile: UserProfile = {
              nickname: user.name,
              peerTag: user.id.startsWith('#') ? user.id : `#${user.id}`,
              avatarUrl: user.avatar,
              avatarName: 'Avatar'
            };
            setProfile(loadedProfile);
            localStorage.setItem('elfy_user_profile', JSON.stringify(loadedProfile));
            localStorage.setItem('elfy_user_registered', 'true');
          }
        }
      } catch (err) {
        console.warn('Failed to load profile from db:', err);
      }
    };

    loadFromDb();
  }, []);

  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'elfy_user_profile' && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          setProfile(parsed);
        } catch {}
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const saveProfile = (newProfile: UserProfile) => {
    setProfile(newProfile);
    localStorage.setItem('elfy_user_profile', JSON.stringify(newProfile));
  };

  return { profile, setProfile, saveProfile };
};
