// Runs after electron-builder packs the app but before it compresses the AppImage/NSIS archive.
// Electron ships ~55 Chromium UI-locale files (~44 MB) that a fully custom-rendered app never uses,
// plus software-rendering (Vulkan/SwiftShader) libraries (~7 MB) that OpenCord does not need.
const fs = require('node:fs');
const path = require('node:path');

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function afterPack(context) {
  const { appOutDir } = context;
  const log = (msg) => console.log(`[after-pack] ${msg}`);

  // 1. Strip unused Chromium UI locales. Keep only en-US (the fallback). Date/number formatting
  //    for other locales still works via ICU (icudtl.dat), so the in-app locale setting is unaffected.
  const localesDir = path.join(appOutDir, 'locales');
  if (fs.existsSync(localesDir)) {
    let removed = 0;
    for (const file of fs.readdirSync(localesDir)) {
      if (file.endsWith('.pak') && file !== 'en-US.pak') {
        fs.rmSync(path.join(localesDir, file));
        removed++;
      }
    }
    log(`stripped ${removed} unused locale files`);
  }

  // 2. Remove software WebGL/Vulkan renderers (SwiftShader). OpenCord renders no 3D/WebGL content.
  for (const file of ['libvk_swiftshader.so', 'libvulkan.so.1', 'vk_swiftshader_icd.json']) {
    const p = path.join(appOutDir, file);
    if (fs.existsSync(p)) {
      fs.rmSync(p);
      log(`removed ${file}`);
    }
  }
};
