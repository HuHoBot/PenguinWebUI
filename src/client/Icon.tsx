import type { CSSProperties } from 'react';

type IconName = 'dashboard' | 'settings' | 'terminal' | 'qr' | 'update' | 'server' | 'users' | 'groups' | 'link' | 'arrow' | 'check' | 'shield' | 'end' | 'copy';
const paths: Record<IconName, string> = {
  dashboard: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  terminal: 'M4 6l6 6-6 6 M13 18h7',
  qr: 'M3 3h6v6H3z M15 3h6v6h-6z M3 15h6v6H3z M15 15h3v3h3v3h-6z M12 3v9H3 M12 15v6 M15 12h6',
  update: 'M20 7v5h-5 M4 17v-5h5 M19 11a7 7 0 0 0-12-5L4 9 M5 13a7 7 0 0 0 12 5l3-3',
  server: 'M3 3h18v7H3z M3 14h18v7H3z M7 6.5h.01 M7 17.5h.01 M11 6.5h6 M11 17.5h6',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M18 8a3 3 0 0 0 0-6 M22 21v-2a4 4 0 0 0-3-4',
  groups: 'M4 3h16v14H9l-5 4z M8 7h8 M8 11h5',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  check: 'M5 12l4 4L19 6',
  shield: 'M12 3l9 4v6c0 5-9 9-9 9s-9-4-9-9V7z M8 12l3 3 5-6',
  end: 'M9 4H4v16h5 M10 12h11 M17 8l4 4-4 4',
  copy: 'M8 8h13v13H8z M16 8V3H3v13h5',
};

export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}

export type { IconName };
