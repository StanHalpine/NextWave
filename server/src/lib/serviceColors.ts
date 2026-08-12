/**
 * Service color library — a fixed swatch set, not free-form color picking.
 *
 * Grouped by discipline so a service can only be assigned a shade from its
 * own family: Chiropractic browns, Functional Medicine greens, Longevity
 * blues. The `family` string is the exact `Service.category` value, so
 * matching a service to its allowed swatches is a plain equality check, not
 * a second mapping to keep in sync.
 *
 * Stored on Service as the swatch KEY, not the hex — the hex lives here only,
 * so nudging a shade later updates every service using it at once, and the
 * admin screen can tell "is this swatch selected" by key equality.
 *
 * All swatches sit at or below the lightness of the existing --brass status
 * color, which the dashboard already renders with white event text — new
 * swatches keep that same white-text contrast without a per-color check.
 */

export interface ServiceColorSwatch {
  key: string;
  label: string;
  hex: string;
  family: 'Chiropractic' | 'Functional Medicine' | 'Longevity';
}

export const SERVICE_COLOR_PALETTE: ServiceColorSwatch[] = [
  // Chiropractic — browns
  { key: 'chiro_saddle', label: 'Saddle', hex: '#8B5A2B', family: 'Chiropractic' },
  { key: 'chiro_golden', label: 'Golden', hex: '#A6790E', family: 'Chiropractic' },
  { key: 'chiro_khaki', label: 'Khaki', hex: '#8C7853', family: 'Chiropractic' },
  { key: 'chiro_peru', label: 'Peru', hex: '#9C5F2E', family: 'Chiropractic' },
  { key: 'chiro_bronze', label: 'Bronze', hex: '#6E4A2E', family: 'Chiropractic' },
  { key: 'chiro_umber', label: 'Umber', hex: '#5A3D28', family: 'Chiropractic' },

  // Functional Medicine — greens
  { key: 'fm_hunter', label: 'Hunter', hex: '#3D6B35', family: 'Functional Medicine' },
  { key: 'fm_grass', label: 'Grass', hex: '#5B8C3A', family: 'Functional Medicine' },
  { key: 'fm_jade', label: 'Jade', hex: '#2E8B6B', family: 'Functional Medicine' },
  { key: 'fm_lime', label: 'Lime', hex: '#6B8E2E', family: 'Functional Medicine' },
  { key: 'fm_shamrock', label: 'Shamrock', hex: '#2F9E5C', family: 'Functional Medicine' },
  { key: 'fm_forest', label: 'Forest', hex: '#345E2E', family: 'Functional Medicine' },

  // Longevity — blues
  { key: 'long_midnight', label: 'Midnight', hex: '#2A3B6B', family: 'Longevity' },
  { key: 'long_cobalt', label: 'Cobalt', hex: '#2E5CA6', family: 'Longevity' },
  { key: 'long_periwinkle', label: 'Periwinkle', hex: '#5B6FB0', family: 'Longevity' },
  { key: 'long_sky', label: 'Sky', hex: '#3A7CA8', family: 'Longevity' },
  { key: 'long_ice', label: 'Ice', hex: '#2E7C8C', family: 'Longevity' },
  { key: 'long_slate', label: 'Slate', hex: '#41547A', family: 'Longevity' },
];

const BY_KEY = new Map(SERVICE_COLOR_PALETTE.map((s) => [s.key, s]));

export const SERVICE_COLOR_KEYS = SERVICE_COLOR_PALETTE.map((s) => s.key) as [string, ...string[]];

export function colorHexFor(key: string): string {
  return BY_KEY.get(key)?.hex ?? '#9c9a95'; // falls back to the neutral --st-cancelled grey
}

export function swatchesForFamily(family: string): ServiceColorSwatch[] {
  return SERVICE_COLOR_PALETTE.filter((s) => s.family === family);
}
