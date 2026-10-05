// Где установлен агент. Установка из архива выпуска (scripts/pack.mjs,
// install.sh / install.cmd) раскладывается так:
//
//   <корень>/current            → versions/<версия>   (symlink; на Windows — junction)
//   <корень>/versions/<версия>/node/node[.exe]        свой node
//   <корень>/versions/<версия>/app/                   агент: src, node_modules,
//                                                     package-info.json
//
// Служба запускает <корень>/current/node/node … current/app/src/main.js, так
// что обновление (update.js) — это новая папка в versions и переключение
// current, без переустановки службы. Предыдущая версия остаётся для отката.
//
// package-info.json кладёт в app/ только сборка выпуска: его нет — агент
// запущен из репозитория (разработка), и самообновления нет.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const S_APP_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // …/app

/** Платформа выпуска: linux-x64, windows-x64, macos-arm64 … */
export function sPlatformKey(sPlatform = process.platform, sArch = process.arch) {
  const sOs = { win32: 'windows', darwin: 'macos' }[sPlatform] || sPlatform;
  return `${sOs}-${sArch}`;
}

export const sNodeFile = (sPlatform = process.platform) => (sPlatform === 'win32' ? 'node.exe' : 'node');

/**
 * Установка, из которой запущен агент, или null (запуск из репозитория).
 * { sRoot, sVersionDir, sVersion, sPlatform, sUpdateUrl, sCurrentNode, sCurrentMain }
 */
export function oInstallLayout(sAppDir = S_APP_DIR) {
  const sInfo = join(sAppDir, 'package-info.json');
  if (!existsSync(sInfo)) return null;
  const oInfo = JSON.parse(readFileSync(sInfo, 'utf8'));
  // Путь модуля Node уже разрешил через ссылку current — это versions/<версия>/app.
  const sVersionDir = dirname(realpathSync(sAppDir));
  const sVersions = dirname(sVersionDir);
  if (basename(sVersions) !== 'versions') return null;
  const sRoot = dirname(sVersions);
  return {
    sRoot,
    sVersionDir,
    sVersion: oInfo.version,
    sPlatform: oInfo.platform,
    sUpdateUrl: process.env.KKT_AGENT_UPDATE_URL || oInfo.updateUrl || '',
    sCurrentNode: join(sRoot, 'current', 'node', sNodeFile()),
    sCurrentMain: join(sRoot, 'current', 'app', 'src', 'main.js'),
  };
}
