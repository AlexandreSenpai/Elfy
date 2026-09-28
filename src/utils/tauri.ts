import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
};

export const safeInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> => {
  if (!isTauri()) {
    return null;
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`[Tauri] Invoke error for command "${cmd}":`, err);
    return null;
  }
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
  joinedAs?: 'owner' | 'guest'
): Promise<void> => {
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
    safeInvoke('start_dragging');
  }
};

export const setFullscreenTauri = async (fullscreen: boolean): Promise<void> => {
  if (!isTauri()) {
    if (fullscreen) {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen().catch(() => {});
      }
    } else {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }
    }
    return;
  }
  try {
    const win = getCurrentWindow();
    await win.setFullscreen(fullscreen);
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
  if (!isTauri()) {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen().catch(() => {});
      return true;
    } else {
      await document.exitFullscreen().catch(() => {});
      return false;
    }
  }
  try {
    const win = getCurrentWindow();
    const isFull = await win.isFullscreen();
    const target = !isFull;
    await win.setFullscreen(target);
    return target;
  } catch {
    const res = await safeInvoke<boolean>('toggle_fullscreen');
    return res ?? false;
  }
};
