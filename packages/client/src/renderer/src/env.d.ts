/// <reference types="vite/client" />
import type { Native } from '../../preload';

declare global {
  interface Window {
    native?: Native;
  }
}
export {};
