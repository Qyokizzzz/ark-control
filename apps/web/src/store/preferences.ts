import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ThemeName } from '@ark-control/common';

export const usePreferences = create(
  persist<{
    theme: ThemeName;
    language: 'zh-CN' | 'en';
    navigationOrders: Record<string, string[]>;
    setTheme: (theme: ThemeName) => void;
    setLanguage: (language: 'zh-CN' | 'en') => void;
    setNavigationOrder: (accountId: string, order: string[]) => void;
  }>(
    (set) => ({
      theme: 'dark',
      language: 'zh-CN',
      navigationOrders: {},
      setTheme: (theme) => set({ theme }),
      setLanguage: (language) => set({ language }),
      setNavigationOrder: (accountId, order) =>
        set(({ navigationOrders }) => ({
          navigationOrders: { ...navigationOrders, [accountId]: order },
        })),
    }),
    { name: 'ark-preferences' },
  ),
);
