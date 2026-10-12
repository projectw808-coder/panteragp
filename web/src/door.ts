/**
 * The door's second look, taken in the browser: where the device says it is.
 *
 * A visitor in the United States behind a VPN arrives from an address somewhere else,
 * which is the whole point of the VPN, but their device still keeps United States time.
 * The server cannot see that; the page can. Same list as src/geo.ts on the server, which
 * uses it for the public pages.
 */
export const US_TIMEZONES = new Set([
  'America/New_York', 'America/Detroit', 'America/Kentucky/Louisville', 'America/Kentucky/Monticello',
  'America/Indiana/Indianapolis', 'America/Indiana/Vincennes', 'America/Indiana/Winamac', 'America/Indiana/Marengo',
  'America/Indiana/Petersburg', 'America/Indiana/Vevay', 'America/Indiana/Tell_City', 'America/Indiana/Knox',
  'America/Chicago', 'America/Menominee', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem',
  'America/North_Dakota/Beulah', 'America/Denver', 'America/Boise', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Metlakatla', 'America/Yakutat', 'America/Nome',
  'America/Adak', 'Pacific/Honolulu', 'America/Fort_Wayne', 'America/Indianapolis', 'America/Louisville',
  'America/Shiprock', 'America/Atka', 'America/Knox_IN', 'Navajo', 'US/Alaska', 'US/Aleutian', 'US/Arizona',
  'US/Central', 'US/East-Indiana', 'US/Eastern', 'US/Hawaii', 'US/Indiana-Starke', 'US/Michigan', 'US/Mountain',
  'US/Pacific', 'US/Samoa', 'Pacific/Pago_Pago', 'Pacific/Guam', 'Pacific/Saipan', 'America/Puerto_Rico',
  'America/St_Thomas', 'America/Virgin',
]);

export function deviceTimezone(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null; } catch { return null; }
}

export const deviceInUs = () => { const tz = deviceTimezone(); return !!tz && US_TIMEZONES.has(tz); };

export type DoorState = { on: boolean; countries: string[]; timezones: boolean };
