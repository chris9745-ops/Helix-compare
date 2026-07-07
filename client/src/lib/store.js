import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useAppStore = create(
  persist(
    (set, get) => ({
      activeConnectionId: null,
      activeForm: null,

      setActiveConnection: (id) => set({ activeConnectionId: id, activeForm: null }),
      setActiveForm: (formName) => set({ activeForm: formName }),
      clearConnection: () => set({ activeConnectionId: null, activeForm: null }),
    }),
    { name: 'helix-dev-tool-state' }
  )
);
