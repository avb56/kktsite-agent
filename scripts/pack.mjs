#!/usr/bin/env node
// Сборка архива выпуска агента для платформы, на которой запущен (CI —
// .github/workflows/agent-release.yml, по машине на платформу: обёртка
// драйвера — нативный модуль, собирается под свою ОС и node).
//
//   node scripts/pack.mjs [--out dist] [--version 0.2.0] [--update-url https://…/agent/]
//                         [--node-binary <node>] [--platform <ключ>] [--bundle-node12]
//
// Сборка для Windows 7 (Node 12.22 — последний, что идёт на Win7):
//   --node-binary  node 12 (node.exe с nodejs.org) вместо этого node;
//   --platform     windows7-x64 / windows7-ia32 — по этому ключу агент берёт
//                  обновления, сборки на Node 22 ему не подсунутся;
//   --bundle-node12  src собирается esbuild в один CommonJS app/src/main.js
//                  под Node 12 (синтаксис ?. ??, import.meta.url, префикс node:),
//                  app/package.json — без "type": "module"; пути агента
//                  (src/main.js, src/ui, ../package.json) те же. Обёртку драйвера
//                  перед этим собрать под Node 12 (npm_config_target=12.22.12).
//
// Результат: <out>/files/kktsite-agent-<версия>-<платформа>.tar.gz — для
// самообновления и установки на Linux/macOS. Windows-zip для установки руками
// собирает pack-windows.mjs из двух разрядностей (x64 и ia32).
// Внутри — каталог kktsite-agent-<версия>-<платформа>/:
//   node/node[.exe]   этот же node (process.execPath)
//   app/              src, node_modules (без .bin и промежуточной сборки),
//                     package.json с версией, package-info.json
//   install.* uninstall.* README.txt   из packaging/
// Предварительно: npm ci в корне репозитория.

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sNodeFile, sPlatformKey } from '../src/layout.js';
import { pPackTarGz } from '../src/tar.js';

const S_AGENT = fileURLToPath(new URL('..', import.meta.url));
// Отсюда же — страница загрузки (claude-test: docs/deploy/nginx-dl.conf). Агент запоминает
// адрес при сборке: сменили — уже установленные ходят на прежний.
const S_DEFAULT_UPDATE_URL = 'https://dl.kktsite.ru/agent/';

function oArgs(aArgs) {
  const o = {};
  for (let n = 0; n < aArgs.length; n += 1) {
    if (aArgs[n] === '--bundle-node12') { o.bundle = true; continue; }
    const aMatch = /^--(out|version|update-url|node-binary|platform)$/.exec(aArgs[n]);
    if (!aMatch || aArgs[n + 1] === undefined) {
      throw new Error(`Параметры: --out, --version, --update-url, --node-binary, --platform, --bundle-node12 (не понял: ${aArgs[n]})`);
    }
    o[aMatch[1]] = aArgs[++n];
  }
  return o;
}

const oOpts = oArgs(process.argv.slice(2));
const oPackage = JSON.parse(readFileSync(join(S_AGENT, 'package.json'), 'utf8'));
const sVersion = oOpts.version || oPackage.version;
if (!/^\d+\.\d+\.\d+$/.test(sVersion)) throw new Error(`Версия — x.y.z: ${sVersion}`);
const sPlatform = oOpts.platform || sPlatformKey();
const sNodeBinary = oOpts['node-binary'] || process.execPath;
const sName = `kktsite-agent-${sVersion}-${sPlatform}`;
const sOut = oOpts.out || join(S_AGENT, 'dist');
const sStage = join(sOut, 'stage', sName);
const sFiles = join(sOut, 'files');

if (!existsSync(join(S_AGENT, 'node_modules', 'node-atol-wrapper'))) throw new Error('Сначала npm ci в apps/agent');

rmSync(sStage, { recursive: true, force: true });
mkdirSync(join(sStage, 'node'), { recursive: true });
mkdirSync(sFiles, { recursive: true });

cpSync(sNodeBinary, join(sStage, 'node', sNodeFile()));
if (process.platform !== 'win32') chmodSync(join(sStage, 'node', sNodeFile()), 0o755);

const sApp = join(sStage, 'app');
if (oOpts.bundle) await pBundleNode12(join(sApp, 'src'));
else cpSync(join(S_AGENT, 'src'), join(sApp, 'src'), { recursive: true });
// Не кладём: .bin — ссылки на скрипты сборки; obj.target и .deps —
// промежуточная сборка node-gyp (готовый модуль — build/Release/*.node);
// node-atol-wrapper/src — исходники обёртки и библиотеки драйвера Атола под
// все ОС (~100 МБ), оставленные автором обёртки. Библиотеки Атола мы не
// раздаём: агент берёт драйвер, установленный на кассе (план, «Драйвер ДТО —
// на клиенте»); во время работы обёртке src не нужен.
// И зависимости разработки (esbuild — сборщик, кассе не нужен).
const S_WRAPPER_SRC = join(S_AGENT, 'node_modules', 'node-atol-wrapper', 'src');
const S_MODULES = join(S_AGENT, 'node_modules');
const sDev = new Set([...Object.keys(oPackage.devDependencies || {}), '@esbuild'].map((s) => join(S_MODULES, s)));
cpSync(S_MODULES, join(sApp, 'node_modules'), {
  recursive: true,
  dereference: true,
  filter: (sPath) => sPath !== S_WRAPPER_SRC && !sDev.has(sPath) && !['.bin', 'obj.target', '.deps'].includes(basename(sPath)),
});
const { type: _sType, devDependencies: _oDev, ...oAppPackage } = oPackage;
writeFileSync(join(sApp, 'package.json'), JSON.stringify({
  ...(oOpts.bundle ? oAppPackage : { ...oAppPackage, type: oPackage.type }),
  version: sVersion,
}, null, 2) + '\n');
writeFileSync(join(sApp, 'package-info.json'), JSON.stringify({
  version: sVersion,
  platform: sPlatform,
  updateUrl: oOpts['update-url'] || S_DEFAULT_UPDATE_URL,
  node: execFileSync(sNodeBinary, ['--version'], { encoding: 'utf8' }).trim(),
  built: new Date().toISOString(),
}, null, 2) + '\n');

for (const sFile of ['install.sh', 'uninstall.sh', 'install.cmd', 'uninstall.cmd', 'README.txt']) {
  cpSync(join(S_AGENT, 'packaging', sFile), join(sStage, sFile));
  if (sFile.endsWith('.sh')) chmodSync(join(sStage, sFile), 0o755);
}

// Самопроверка сборки — тем же, чем её проверит обновление.
const sSelf = execFileSync(join(sStage, 'node', sNodeFile()), [join(sApp, 'src', 'main.js'), '--version'], { encoding: 'utf8' }).trim();
if (sSelf !== `kktsite-agent ${sVersion}`) throw new Error(`Самопроверка сборки: «${sSelf}»`);

/**
 * src → один CommonJS-файл под Node 12 (сборка для Windows 7). esbuild
 * переписывает синтаксис (?. ?? и пр.); import.meta.url — через __filename;
 * префикс node: снимается — require('node:fs') в Node 12 нет.
 */
async function pBundleNode12(sSrcOut) {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [join(S_AGENT, 'src', 'main.js')],
    outfile: join(sSrcOut, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node12',
    // kkt-core — обфусцированный выпуск: пересборка ломает его (selfDefending),
    // поэтому он едет в node_modules как есть, а не внутрь main.js.
    external: ['node-atol-wrapper', 'kkt-core'],
    define: { 'import.meta.url': '__kktImportMetaUrl' },
    banner: { js: "'use strict';\nconst __kktImportMetaUrl = require('url').pathToFileURL(__filename).href;" },
    plugins: [{
      name: 'strip-node-prefix',
      setup(oBuild) {
        oBuild.onResolve({ filter: /^node:/ }, (oArgs) => ({ path: oArgs.path.slice(5), external: true }));
      },
    }],
    logLevel: 'warning',
  });
  cpSync(join(S_AGENT, 'src', 'ui'), join(sSrcOut, 'ui'), { recursive: true });
}

const sTarGz = join(sFiles, `${sName}.tar.gz`);
await pPackTarGz(sStage, sTarGz, sName);
console.log(sTarGz);
