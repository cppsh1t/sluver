/**
 * App Setting IPC API.
 *
 * Global application preferences live in `meta.db` — the `settings` KV table.
 */

import type { AppSetting } from '@/types';
import { call } from './client';

// ─── App Setting ────────────────────────────────────────────────────────────

export function getAppSetting(): Promise<AppSetting> {
  return call<AppSetting>('get_app_setting');
}

export function updateAppSetting(setting: AppSetting): Promise<AppSetting> {
  return call<AppSetting>('update_app_setting', { setting });
}
