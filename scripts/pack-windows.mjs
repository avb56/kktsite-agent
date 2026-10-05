#!/usr/bin/env node
// Windows-zip выпуска на обе разрядности — для установки руками
// (CI: job collect в .github/workflows/agent-release.yml, на Linux).
//
//   node scripts/pack-windows.mjs <files> [--family windows|windows7]
//
// windows — сборки на Node 22 (Windows 10/11), windows7 — на Node 12 (Win7).
//
// Берёт из <files> kktsite-agent-<v>-windows-x64.tar.gz и -windows-ia32.tar.gz
// (собраны pack.mjs на своих разрядностях) и кладёт туда же
// kktsite-agent-<v>-windows.zip:
//
//   kktsite-agent-<v>-windows/
//     x64/{node,app}   ia32/{node,app}
//     install.cmd  uninstall.cmd  README.txt
//
// install.cmd идёт на 32-битном node и ставит половину под драйвер Атола
// (src/installer.js, src/winreg.js). tar.gz на разрядность остаются —
// по ним обновляются уже установленные агенты.
// zip — свой (zip.mjs): его открывает Проводник, в отличие от zip bsdtar.

import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pExtractTarGz } from '../src/tar.js';
import { pWriteZip } from './zip.mjs';

const aArgv = process.argv.slice(2);
const sFiles = aArgv.find((s) => !s.startsWith('--'));
const nFamily = aArgv.indexOf('--family');
const sFamily = nFamily >= 0 ? aArgv[nFamily + 1] : 'windows';
if (!sFiles || !['windows', 'windows7'].includes(sFamily)) {
  throw new Error('node scripts/pack-windows.mjs <каталог с архивами> [--family windows|windows7]');
}
const R = new RegExp(`^kktsite-agent-(\\d+\\.\\d+\\.\\d+)-${sFamily}-(x64|ia32)\\.tar\\.gz$`);
const aFound = readdirSync(sFiles).map((s) => R.exec(s)).filter(Boolean);
const aVersions = [...new Set(aFound.map((a) => a[1]))];
if (aVersions.length !== 1) throw new Error(`Нужны архивы ${sFamily}-x64 и ${sFamily}-ia32 одной версии, нашлось: ${aFound.map((a) => a[0]).join(', ') || 'ничего'}`);
const sVersion = aVersions[0];
for (const sArch of ['x64', 'ia32']) {
  if (!aFound.some((a) => a[2] === sArch)) throw new Error(`Нет kktsite-agent-${sVersion}-${sFamily}-${sArch}.tar.gz`);
}

const sName = `kktsite-agent-${sVersion}-${sFamily}`;
const sTmp = mkdtempSync(join(tmpdir(), 'kkt-pack-windows-'));
const sStage = join(sTmp, sName);
try {
  for (const sArch of ['x64', 'ia32']) {
    const sDir = join(sStage, sArch);
    await pExtractTarGz(join(sFiles, `kktsite-agent-${sVersion}-${sFamily}-${sArch}.tar.gz`), sDir, { nStrip: 1 });
    // Сценарии и README — один раз, наверху; в половинах — только node и app.
    for (const sFile of readdirSync(sDir)) {
      if (sFile === 'node' || sFile === 'app') continue;
      if (sArch === 'x64' && /\.(cmd|txt)$/.test(sFile)) cpSync(join(sDir, sFile), join(sStage, sFile));
      rmSync(join(sDir, sFile), { recursive: true, force: true });
    }
  }
  mkdirSync(sFiles, { recursive: true });
  const sZip = join(sFiles, `${sName}.zip`);
  await pWriteZip(sStage, sZip, sName);
  console.log(sZip);
} finally {
  rmSync(sTmp, { recursive: true, force: true });
}
