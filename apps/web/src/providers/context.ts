import { createContext, useContext } from 'react';
export const WindowSizeContext = createContext({ mobile: false });
export function useWindowSize() {
  return useContext(WindowSizeContext);
}
