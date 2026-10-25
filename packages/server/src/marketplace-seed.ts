import type { DB } from './db';

// Official catalog. Assets prefixed with "builtin:" are rendered by the client (CSS/SVG), so the
// server ships no binary art. Ids are fixed so re-seeding is idempotent.
const ITEMS: { id: string; category: string; name: string; description: string; asset: string; colors?: string[]; tags: string[] }[] = [
  // Avatar decorations
  { id: '100000000000000001', category: 'avatar_decoration', name: 'Neon Ring', description: 'A glowing ring that pulses softly.', asset: 'builtin:deco/neon-ring', tags: ['glow', 'neon'] },
  { id: '100000000000000002', category: 'avatar_decoration', name: 'Cat Ears', description: 'Purr-fect for any profile.', asset: 'builtin:deco/cat-ears', tags: ['cute', 'animal'] },
  { id: '100000000000000003', category: 'avatar_decoration', name: 'Flame Crown', description: 'A ring of flickering fire.', asset: 'builtin:deco/flame', tags: ['fire'] },
  { id: '100000000000000004', category: 'avatar_decoration', name: 'Sakura', description: 'Cherry blossoms drifting around you.', asset: 'builtin:deco/sakura', tags: ['flowers', 'pink'] },
  { id: '100000000000000005', category: 'avatar_decoration', name: 'Pixel Frame', description: 'Retro 8-bit border.', asset: 'builtin:deco/pixel', tags: ['retro', 'gaming'] },
  { id: '100000000000000006', category: 'avatar_decoration', name: 'Halo', description: 'Angelic and golden.', asset: 'builtin:deco/halo', tags: ['gold'] },
  { id: '100000000000000007', category: 'avatar_decoration', name: 'Headphones', description: 'Always vibing.', asset: 'builtin:deco/headphones', tags: ['music'] },
  { id: '100000000000000008', category: 'avatar_decoration', name: 'Rainbow Orbit', description: 'Spinning spectrum.', asset: 'builtin:deco/rainbow', tags: ['rainbow', 'animated'] },
  // Profile effects
  { id: '100000000000000101', category: 'profile_effect', name: 'Snowfall', description: 'Gentle snow over your profile.', asset: 'builtin:effect/snow', tags: ['winter'] },
  { id: '100000000000000102', category: 'profile_effect', name: 'Sparkles', description: 'Twinkling stars.', asset: 'builtin:effect/sparkles', tags: ['stars'] },
  { id: '100000000000000103', category: 'profile_effect', name: 'Hearts', description: 'Floating hearts.', asset: 'builtin:effect/hearts', tags: ['love'] },
  { id: '100000000000000104', category: 'profile_effect', name: 'Matrix', description: 'Falling green code.', asset: 'builtin:effect/matrix', tags: ['hacker'] },
  { id: '100000000000000105', category: 'profile_effect', name: 'Bubbles', description: 'Rising bubbles.', asset: 'builtin:effect/bubbles', tags: ['water'] },
  // Nameplates
  { id: '100000000000000201', category: 'nameplate', name: 'Aurora', description: 'Northern lights behind your name.', asset: 'builtin:plate/aurora', colors: ['#1a2a6c', '#2ecc71', '#8e44ad'], tags: ['gradient'] },
  { id: '100000000000000202', category: 'nameplate', name: 'Sunset', description: 'Warm evening sky.', asset: 'builtin:plate/sunset', colors: ['#ff7e5f', '#feb47b'], tags: ['gradient'] },
  { id: '100000000000000203', category: 'nameplate', name: 'Ocean', description: 'Deep blue waves.', asset: 'builtin:plate/ocean', colors: ['#0f2027', '#2c5364'], tags: ['gradient'] },
  { id: '100000000000000204', category: 'nameplate', name: 'Galaxy', description: 'Stars and nebulae.', asset: 'builtin:plate/galaxy', colors: ['#200122', '#6f0000'], tags: ['space'] },
  // Banners
  { id: '100000000000000301', category: 'banner', name: 'Mountain Dusk', description: 'Layered peaks at sundown.', asset: 'builtin:banner/mountains', colors: ['#2c3e50', '#fd746c'], tags: ['nature'] },
  { id: '100000000000000302', category: 'banner', name: 'Synthwave', description: 'Retro grid horizon.', asset: 'builtin:banner/synthwave', colors: ['#2b1055', '#d53369'], tags: ['retro'] },
  { id: '100000000000000303', category: 'banner', name: 'Forest', description: 'Misty pines.', asset: 'builtin:banner/forest', colors: ['#134e5e', '#71b280'], tags: ['nature'] },
  { id: '100000000000000304', category: 'banner', name: 'Waves', description: 'Layered ocean waves.', asset: 'builtin:banner/waves', colors: ['#2193b0', '#6dd5ed'], tags: ['water'] },
  // Profile themes
  { id: '100000000000000401', category: 'profile_theme', name: 'Midnight', description: 'Deep indigo profile theme.', asset: 'builtin:theme', colors: ['#141e30', '#243b55'], tags: ['dark'] },
  { id: '100000000000000402', category: 'profile_theme', name: 'Bubblegum', description: 'Pink and playful.', asset: 'builtin:theme', colors: ['#ff9a9e', '#fad0c4'], tags: ['pink'] },
  { id: '100000000000000403', category: 'profile_theme', name: 'Mint', description: 'Fresh and green.', asset: 'builtin:theme', colors: ['#11998e', '#38ef7d'], tags: ['green'] },
  { id: '100000000000000404', category: 'profile_theme', name: 'Ember', description: 'Smouldering orange.', asset: 'builtin:theme', colors: ['#f12711', '#f5af19'], tags: ['orange'] },
  { id: '100000000000000405', category: 'profile_theme', name: 'Royal', description: 'Purple and gold.', asset: 'builtin:theme', colors: ['#41295a', '#2f0743'], tags: ['purple'] },
];

export function seedMarketplace(db: DB) {
  const stmt = db.prepare(
    `INSERT INTO marketplace_items (id, category, name, description, asset, colors, official, status, tags, created_at)
     VALUES (@id, @category, @name, @description, @asset, @colors, 1, 'approved', @tags, @created_at)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, asset = excluded.asset,
       colors = excluded.colors, tags = excluded.tags`,
  );
  db.transaction(() => {
    for (const it of ITEMS) {
      stmt.run({ ...it, colors: it.colors ? JSON.stringify(it.colors) : null, tags: JSON.stringify(it.tags), created_at: 1767225600000 });
    }
  })();
}
