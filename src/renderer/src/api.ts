import type { NestApi } from '@shared/ipc';
import { createWebApi } from './web/client';

declare global {
  interface Window {
    nest?: NestApi;
  }
}

/** True in a phone's browser, talking to Nest on the PC over Tailscale; false in the desktop app. */
export const IS_REMOTE = !window.nest;

export const api: NestApi = window.nest ?? createWebApi();
