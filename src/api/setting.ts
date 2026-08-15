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

// ─── System fonts ───────────────────────────────────────────────────────────

/**
 * List font families installed on the OS (sorted). Used by the Settings font
 * pickers — the list is rendered as a searchable combobox because it can
 * contain hundreds of entries.
 */
export function listSystemFonts(): Promise<string[]> {
  return call<string[]>('list_system_fonts');
}
