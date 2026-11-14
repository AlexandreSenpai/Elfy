import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { commands } from '@skipperndt/plugin-machine-uid';
import {
  FriendHubRecordDto,
  HostResourceMetricsDto,
  ProfileRowDto,
  RoomRole,
  StreamFpsOption,
  TelemetryConsentState,
} from '../domain/dtos';

const TEST_MACHINE_UID_STORAGE_KEY = 'elfy_test_machine_uid';

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

/** Returns true when executing inside the Tauri desktop runtime. */
export const isTauri = (): boolean => {
  if (typeof window === 'undefined') return false;
  return Boolean((window as TauriWindow).__TAURI_INTERNALS__);
};

/** Invokes a Tauri command safely, returning null when outside Tauri or on IPC error. */
export const safeInvoke = async <T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T | null> => {
  if (!isTauri()) return null;

  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`[Tauri] Invoke error for command "${cmd}":`, err);
    return null;
  }
};

/** Invokes a Tauri command and throws if outside Tauri or if the command fails. */
export const invokeOrThrow = async <T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> => {
  if (!isTauri()) {
    throw new Error(`Tauri runtime unavailable for command "${cmd}"`);
  }
  return invoke<T>(cmd, args);
};

const createBrowserTestUid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `test-${crypto.randomUUID()}`;
  }
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

/** Resolves the hardware machine UID in Tauri or per-session test UID in browser mode. */
export const resolveMachineUid = async (): Promise<string> => {
  if (isTauri()) {
    const result = await commands.getMachineUid();
    if (result.status !== 'ok' || !result.data.id) {
      throw new Error('Failed to retrieve machine UID from Tauri plugin');
    }
    return result.data.id;
  }

  const existing = sessionStorage.getItem(TEST_MACHINE_UID_STORAGE_KEY);
  if (existing && existing.trim()) return existing;

  const generated = createBrowserTestUid();
  sessionStorage.setItem(TEST_MACHINE_UID_STORAGE_KEY, generated);
  return generated;
};

export const showRegisterWindowTauri = async (): Promise<void> => {
  await safeInvoke('show_register_window');
};

export const closeRegisterWindowTauri = async (): Promise<void> => {
  await safeInvoke('close_register_window');
};

export const openStreamWindowTauri = async (
  hubId?: string,
  autoStart: boolean = false,
  joinedAs?: RoomRole
): Promise<void> => {
  if (!isTauri()) return;
  await safeInvoke('open_stream_window', { hubId, autoStart });
  await emit('request-start-stream', { hubId, autoStart, joinedAs });
};

export const closeStreamWindowTauri = async (): Promise<void> => {
  await safeInvoke('close_stream_window');
};

export const hideMainWindowTauri = async (): Promise<void> => {
  await safeInvoke('hide_main_window');
};

export const minimizeWindowTauri = async (): Promise<void> => {
  if (!isTauri()) return;
  try {
    await getCurrentWindow().minimize();
  } catch {
    await safeInvoke('minimize_window');
  }
};

export const toggleMaximizeWindowTauri = async (): Promise<void> => {
  if (!isTauri()) return;
  try {
    await getCurrentWindow().toggleMaximize();
  } catch {
    await safeInvoke('toggle_maximize_window');
  }
};

export const startDraggingTauri = (): void => {
  if (!isTauri()) return;
  try {
    getCurrentWindow().startDragging().catch(() => {});
  } catch {
    void safeInvoke('start_dragging');
  }
};

const setBrowserFullscreen = async (fullscreen: boolean): Promise<void> => {
  if (fullscreen && !document.fullscreenElement) {
    await document.documentElement.requestFullscreen().catch(() => {});
    return;
  }
  if (!fullscreen && document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  }
};

export const setFullscreenTauri = async (fullscreen: boolean): Promise<void> => {
  if (!isTauri()) {
    await setBrowserFullscreen(fullscreen);
    return;
  }

  try {
    await getCurrentWindow().setFullscreen(fullscreen);
  } catch {
    await safeInvoke('set_fullscreen', { fullscreen });
  }
};

export const isFullscreenTauri = async (): Promise<boolean> => {
  if (!isTauri()) {
    return Boolean(document.fullscreenElement);
  }

  try {
    return await getCurrentWindow().isFullscreen();
  } catch {
    const res = await safeInvoke<boolean>('is_fullscreen');
    return res ?? false;
  }
};

export const toggleFullscreenTauri = async (): Promise<boolean> => {
  const currentlyFull = await isFullscreenTauri();
  const target = !currentlyFull;
  await setFullscreenTauri(target);
  return target;
};

export const dbGetOrInitProfileTauri = (
  rawMachineUid: string,
  defaultNickname: string,
  defaultTag: string,
  defaultAvatar: string
): Promise<ProfileRowDto> => {
  return invokeOrThrow<ProfileRowDto>('db_get_or_init_profile', {
    rawMachineUid,
    defaultNickname,
    defaultTag,
    defaultAvatar,
  });
};

export const dbUpdateProfileTauri = (
  rawMachineUid: string,
  nickname: string,
  avatarUrl: string,
  preferredFps?: StreamFpsOption
): Promise<ProfileRowDto> => {
  return invokeOrThrow<ProfileRowDto>('db_update_profile', {
    rawMachineUid,
    nickname,
    avatarUrl,
    preferredFps: preferredFps ?? null,
  });
};

export const dbSetTelemetryConsentTauri = (
  rawMachineUid: string,
  consent: TelemetryConsentState
): Promise<ProfileRowDto> => {
  return invokeOrThrow<ProfileRowDto>('db_set_telemetry_consent', {
    rawMachineUid,
    consent,
  });
};

export const dbListFriendHubsTauri = (): Promise<FriendHubRecordDto[]> => {
  return invokeOrThrow<FriendHubRecordDto[]>('db_list_friend_hubs');
};

export const dbUpsertFriendHubTauri = (
  hub: FriendHubRecordDto
): Promise<FriendHubRecordDto[]> => {
  return invokeOrThrow<FriendHubRecordDto[]>('db_upsert_friend_hub', { hub });
};

export const dbRemoveFriendHubTauri = (hubId: string): Promise<FriendHubRecordDto[]> => {
  return invokeOrThrow<FriendHubRecordDto[]>('db_remove_friend_hub', { hubId });
};

export const getSystemMetricsTauri = (): Promise<HostResourceMetricsDto | null> => {
  return safeInvoke<HostResourceMetricsDto>('get_system_metrics');
};
