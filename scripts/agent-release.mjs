#!/usr/bin/env node
// Подпись выпуска агента — на машине того, кто выкладывает, не в CI: взломав
// GitHub или Actions, подменённое обновление кассам не разослать.
//
//   node scripts/agent-release.mjs keygen          — выпустить ключ подписи (один раз)
//   node scripts/agent-release.mjs sign <каталог>  — latest.json и latest.json.sig
//   node scripts/agent-release.mjs verify <каталог> — проверить подпись, как агент
//
// <каталог> — распакованный артефакт сборки выпуска (Actions, agent-release):
// files/kktsite-agent-<версия>-<платформа>.tar.gz (+ .zip для Windows).
// Обычно не руками: scripts/agent-ship.sh распаковывает артефакт, подписывает
// и выкладывает на узел одной командой.
//
// Ключ: ~/.config/kktsite-agent-release/signing-key.pem (0600), или путь в
// KKT_AGENT_SIGNING_KEY. Открытый ключ — в src/update.js (S_PUBLIC_KEY):
// сменили ключ — агенты старых выпусков новые обновления не примут, их
// обновляют установщиком.

import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { oVerifyManifest } from '../src/update.js';

const S_KEY = process.env.KKT_AGENT_SIGNING_KEY || join(homedir(), '.config', 'kktsite-agent-release', 'signing-key.pem');
// Платформа — os-arch (linux-x64, windows-ia32, windows7-x64 …); у Windows-zip
// на обе разрядности — просто windows / windows7.
const R_ARCHIVE = /^kktsite-agent-(\d+\.\d+\.\d+)-([a-z0-9]+(?:-[a-z0-9]+)?)\.(tar\.gz|zip)$/;

async function pSha256(sFile) {
  const oHash = createHash('sha256');
  for await (const oChunk of createReadStream(sFile)) oHash.update(oChunk);
  return oHash.digest('hex');
}

function fKeygen() {
  if (existsSync(S_KEY)) throw new Error(`Ключ уже есть: ${S_KEY}. Новый ключ — только осознанно: старые агенты его не примут.`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(join(S_KEY, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(S_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`Закрытый ключ: ${S_KEY} (0600). Храните и не передавайте; потеряли — новые обновления агенты не примут.`);
  console.log('Открытый ключ — в src/update.js, S_PUBLIC_KEY:');
  console.log(publicKey.export({ type: 'spki', format: 'pem' }));
}

async function pSign(sDir) {
  const sFiles = join(sDir, 'files');
  const aNames = readdirSync(sFiles).filter((s) => R_ARCHIVE.test(s)).sort();
  if (!aNames.length) throw new Error(`В ${sFiles} нет архивов kktsite-agent-<версия>-<платформа>.tar.gz`);
  const aVersions = [...new Set(aNames.map((s) => R_ARCHIVE.exec(s)[1]))];
  if (aVersions.length !== 1) throw new Error(`В каталоге несколько версий: ${aVersions.join(', ')}`);
  const oManifest = { product: 'kktsite-agent', version: aVersions[0], released: new Date().toISOString(), files: {}, installers: {} };
  for (const sName of aNames) {
    const [, , sPlatform, sExt] = R_ARCHIVE.exec(sName);
    const sPath = join(sFiles, sName);
    const oEntry = { file: `files/${sName}`, sha256: await pSha256(sPath), size: statSync(sPath).size };
    // tar.gz — для самообновления (и установки на Linux/macOS); zip — Windows,
    // обе разрядности, для установки руками (pack-windows.mjs).
    (sExt === 'tar.gz' ? oManifest.files : oManifest.installers)[sPlatform] = oEntry;
  }
  const sText = JSON.stringify(oManifest, null, 2) + '\n';
  const oSignature = sign(null, Buffer.from(sText), createPrivateKey(readFileSync(S_KEY)));
  writeFileSync(join(sDir, 'latest.json'), sText);
  writeFileSync(join(sDir, 'latest.json.sig'), oSignature.toString('base64') + '\n');
  oVerifyManifest(sText, oSignature.toString('base64')); // открытый ключ агента подходит к этому закрытому
  console.log(`Подписано: ${oManifest.version}, платформы: ${Object.keys(oManifest.files).join(', ')}`);
}

function fVerify(sDir) {
  const oManifest = oVerifyManifest(readFileSync(join(sDir, 'latest.json'), 'utf8'), readFileSync(join(sDir, 'latest.json.sig'), 'utf8'));
  console.log(`Подпись верна: ${oManifest.version}, ${Object.keys(oManifest.files).join(', ')}`);
}

const [sCommand, sDir] = process.argv.slice(2);
try {
  if (sCommand === 'keygen') fKeygen();
  else if (sCommand === 'sign' && sDir) await pSign(sDir);
  else if (sCommand === 'verify' && sDir) fVerify(sDir);
  else throw new Error('Команды: keygen | sign <каталог> | verify <каталог>');
} catch (oError) {
  console.error(oError.message);
  process.exit(1);
}
