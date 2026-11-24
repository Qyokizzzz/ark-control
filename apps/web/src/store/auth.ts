import { create } from 'zustand';
import type { Admin } from '@ark-control/common';

interface AuthState {
  accessToken: string | null;
  admin: Admin | null;
  initialized: boolean;
  setSession: (token: string, admin: Admin) => void;
  clear: () => void;
  finishInitialization: () => void;
}
export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  admin: null,
  initialized: false,
  setSession: (accessToken, admin) => set({ accessToken, admin, initialized: true }),
  clear: () => set({ accessToken: null, admin: null, initialized: true }),
  finishInitialization: () => set({ initialized: true }),
}));
