import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './DockContextMenu.module.css';
import { quitAppTauri } from '../../utils/tauri';

export interface DockContextMenuPosition {
  x: number;
  y: number;
}

export interface UseDockContextMenuResult {
  menuPosition: DockContextMenuPosition | null;
  openAt: (x: number, y: number) => void;
  closeMenu: () => void;
  handleDockContextMenu: (e: React.MouseEvent) => void;
}

export const useDockContextMenu = (): UseDockContextMenuResult => {
  const [menuPosition, setMenuPosition] = useState<DockContextMenuPosition | null>(null);

  const openAt = useCallback((x: number, y: number) => {
    setMenuPosition({ x, y });
  }, []);

  const closeMenu = useCallback(() => {
    setMenuPosition(null);
  }, []);

  const handleDockContextMenu = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      openAt(e.clientX, e.clientY);
    },
    [openAt]
  );

  return {
    menuPosition,
    openAt,
    closeMenu,
    handleDockContextMenu,
  };
};

interface DockContextMenuProps {
  position: DockContextMenuPosition | null;
  onClose: () => void;
}

export const DockContextMenu: React.FC<DockContextMenuProps> = ({ position, onClose }) => {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!position) return;

    const handlePointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [position, onClose]);

  if (!position) {
    return null;
  }

  const maxLeft = Math.max(8, window.innerWidth - 192);
  const maxTop = Math.max(8, window.innerHeight - 96);
  const left = Math.min(Math.max(8, position.x), maxLeft);
  const top = Math.min(Math.max(8, position.y), maxTop);

  const handleCloseElfy = (): void => {
    onClose();
    void quitAppTauri();
  };

  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      data-testid="dock-context-menu"
      data-no-drag="true"
      role="menu"
      style={{ left: `${left}px`, top: `${top}px` }}
    >
      <button
        className={`${styles.item} ${styles.itemDanger}`}
        data-testid="close-elfy-menu-btn"
        onClick={handleCloseElfy}
        role="menuitem"
        type="button"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
          power_settings_new
        </span>
        <span>Close Elfy</span>
      </button>
      <div className={styles.divider} />
      <button
        className={styles.item}
        data-testid="dismiss-dock-menu-btn"
        onClick={onClose}
        role="menuitem"
        type="button"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
          close
        </span>
        <span>Dismiss</span>
      </button>
    </div>,
    document.body
  );
};
