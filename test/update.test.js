// Самообновление и tar: подпись latest.json, распаковка, переключение current.
// Выпуск подделывается: «node» в нём — shell-скрипт, который отвечает на
// --version, поэтому полный цикл идёт только на Linux и macOS.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const sTmp = mkdtempSync(join(tmpdir(), 'kkt-agent-update-'));
process.env.KKT_AGENT_DATA = join(sTmp, 'data');

const { nCompareVersions, oVerifyManifest, Updater } = await import('../src/update.js');
const { pPackTarGz, pExtractTarGz } = await import('../src/tar.js');
const { sPlatformKey } = await import('../src/layout.js');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const sPublicKey = publicKey.export({ type: 'spki', format: 'pem' });
const fSign = (sText) => sign(null, Buffer.from(sText), privateKey).toString('base64');

after(() => rmSync(sTmp, { recursive: true, force: true }));

test('сравнение версий', () => {
  assert.ok(nCompareVersions('0.2.0', '0.1.9') > 0);
  assert.ok(nCompareVersions('0.10.0', '0.9.0') > 0, 'числами, не строками');
  assert.equal(nCompareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(nCompareVersions('1.0.0', '1.0.1') < 0);
});

test('подпись latest.json: своя принимается, подмена и чужой ключ — нет', () => {
  const sText = JSON.stringify({ product: 'kktsite-agent', version: '0.2.0', files: {} });
  assert.equal(oVerifyManifest(sText, fSign(sText), sPublicKey).version, '0.2.0');
  assert.throws(() => oVerifyManifest(sText.replace('0.2.0', '0.9.9'), fSign(sText), sPublicKey), /Подпись/);
  const oOther = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => oVerifyManifest(sText, fSign(sText), oOther), /Подпись/);
  assert.throws(() => oVerifyManifest(sText, fSign(sText)), /Подпись/, 'ключ агента — не тестовый');
});

test('tar: длинные пути, исполняемость, туда и обратно', async () => {
  const sSrc = join(sTmp, 'tar-src');
  const sLong = join(sSrc, 'a'.repeat(60), 'b'.repeat(60));
  mkdirSync(sLong, { recursive: true });
  writeFileSync(join(sLong, 'file.txt'), 'длинный путь');
  writeFileSync(join(sSrc, 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(sSrc, 'run.sh'), 0o755);
  writeFileSync(join(sSrc, 'empty'), '');
  await pPackTarGz(sSrc, join(sTmp, 't.tar.gz'), 'top');
  await pExtractTarGz(join(sTmp, 't.tar.gz'), join(sTmp, 'tar-out'), { nStrip: 1 });
  assert.equal(readFileSync(join(sTmp, 'tar-out', 'a'.repeat(60), 'b'.repeat(60), 'file.txt'), 'utf8'), 'длинный путь');
  assert.equal(readFileSync(join(sTmp, 'tar-out', 'empty'), 'utf8'), '');
  if (process.platform !== 'win32') assert.ok(statSync(join(sTmp, 'tar-out', 'run.sh')).mode & 0o100, 'исполняемый');
});

test('tar: путь за пределы каталога — ошибка', async () => {
  const oHeader = Buffer.alloc(512);
  oHeader.write('top/../../evil.txt', 0);
  oHeader.write('0000644\0', 100);
  oHeader.write('00000000004\0', 124);
  oHeader.write('0', 156);
  oHeader.fill(' ', 148, 156);
  let nSum = 0;
  for (const n of oHeader) nSum += n;
  oHeader.write(nSum.toString(8).padStart(6, '0') + '\0 ', 148);
  const oBody = Buffer.alloc(512);
  oBody.write('evil');
  writeFileSync(join(sTmp, 'evil.tar.gz'), gzipSync(Buffer.concat([oHeader, oBody, Buffer.alloc(1024)])));
  await assert.rejects(pExtractTarGz(join(sTmp, 'evil.tar.gz'), join(sTmp, 'evil-out')), /Недопустимый путь/);
  assert.ok(!existsSync(join(sTmp, 'evil.txt')));
});

// ——— полный цикл обновления ———

const bUnix = process.platform !== 'win32';
const sPlatform = sPlatformKey();
let oServer;
let sUpdateUrl;
const oServed = new Map(); // путь → Buffer

before(async () => {
  oServer = createServer((oReq, oRes) => {
    const oBody = oServed.get(new URL(oReq.url, 'http://x').pathname);
    oRes.writeHead(oBody ? 200 : 404);
    oRes.end(oBody);
  });
  await new Promise((f) => oServer.listen(0, '127.0.0.1', f));
  sUpdateUrl = `http://127.0.0.1:${oServer.address().port}/agent/`;
});
after(() => oServer.close());

/** Поддельный выпуск: node — скрипт, отвечающий «kktsite-agent <sAnswer>». */
async function pFakeRelease(sVersion, { sAnswer = sVersion, bBadHash = false } = {}) {
  const sStage = join(sTmp, `stage-${sVersion}-${sAnswer}`);
  mkdirSync(join(sStage, 'node'), { recursive: true });
  mkdirSync(join(sStage, 'app', 'src'), { recursive: true });
  writeFileSync(join(sStage, 'node', 'node'), `#!/bin/sh\necho "kktsite-agent ${sAnswer}"\n`);
  chmodSync(join(sStage, 'node', 'node'), 0o755);
  writeFileSync(join(sStage, 'app', 'src', 'main.js'), '// подделка\n');
  const sArchive = join(sTmp, `rel-${sVersion}-${sAnswer}.tar.gz`);
  await pPackTarGz(sStage, sArchive, `kktsite-agent-${sVersion}-${sPlatform}`);
  const oArchive = readFileSync(sArchive);
  const sFile = `files/kktsite-agent-${sVersion}-${sPlatform}.tar.gz`;
  const sManifest = JSON.stringify({
    product: 'kktsite-agent',
    version: sVersion,
    released: new Date().toISOString(),
    files: { [sPlatform]: { file: sFile, size: oArchive.length, sha256: bBadHash ? '0'.repeat(64) : createHash('sha256').update(oArchive).digest('hex') } },
  });
  oServed.set(`/agent/${sFile}`, oArchive);
  oServed.set('/agent/latest.json', Buffer.from(sManifest));
  oServed.set('/agent/latest.json.sig', Buffer.from(fSign(sManifest)));
}

function oFakeInstall(sName) {
  const sRoot = join(sTmp, sName);
  mkdirSync(join(sRoot, 'versions', '0.1.0'), { recursive: true });
  mkdirSync(join(sRoot, 'versions', '0.0.9'), { recursive: true });
  writeFileSync(join(sRoot, 'versions', '0.1.0', 'marker'), '0.1.0');
  return { sRoot, sVersionDir: join(sRoot, 'versions', '0.1.0'), sVersion: '0.1.0', sPlatform, sUpdateUrl };
}

test('обновление: скачать, проверить, переключить current, перезапуститься', { skip: !bUnix && 'node-подделка — shell-скрипт' }, async () => {
  await pFakeRelease('0.2.0');
  const oLayout = oFakeInstall('root-ok');
  let nExits = 0;
  const oUpdater = new Updater({ oLayout, sPublicKey, fExit: () => { nExits += 1; } });

  await oUpdater.pCheck();
  assert.deepEqual(oUpdater.oStatus().available.version, '0.2.0');

  assert.equal(await oUpdater.pInstall(), true);
  assert.equal(readlinkSync(join(oLayout.sRoot, 'current')), join('versions', '0.2.0'));
  assert.ok(existsSync(join(oLayout.sRoot, 'current', 'node', 'node')));
  assert.ok(existsSync(join(oLayout.sRoot, 'versions', '0.1.0', 'marker')), 'предыдущая версия оставлена для отката');
  assert.ok(!existsSync(join(oLayout.sRoot, 'versions', '0.0.9')), 'старшие удалены');
  assert.equal(oUpdater.oStatus().state, 'restarting');
  await new Promise((f) => setTimeout(f, 700));
  assert.equal(nExits, 1, 'агент завершился — служба поднимет новую версию');
});

test('обновление: подменённый архив и непрошедшая самопроверка — не переключаемся', { skip: !bUnix && 'node-подделка — shell-скрипт' }, async () => {
  const oLayout = oFakeInstall('root-bad');
  const oUpdater = new Updater({ oLayout, sPublicKey, fExit: () => assert.fail('не должен перезапускаться') });

  await pFakeRelease('0.3.0', { bBadHash: true });
  await assert.rejects(oUpdater.pInstall(), /sha256/);
  assert.ok(!existsSync(join(oLayout.sRoot, 'current')), 'current не тронут');
  assert.ok(!existsSync(join(oLayout.sRoot, 'versions', '0.3.0')));
  assert.match(oUpdater.oStatus().lastError, /не удалось/);

  await pFakeRelease('0.3.0', { sAnswer: '0.0.1' });
  await assert.rejects(oUpdater.pInstall(), /Самопроверка/);
  assert.ok(!existsSync(join(oLayout.sRoot, 'versions', '0.3.0')), 'непроверенная версия не остаётся');
  assert.equal(oUpdater.oStatus().state, 'idle');
});

test('обновление: без установки — нет', async () => {
  const oUpdater = new Updater({ oLayout: null });
  assert.equal(oUpdater.oStatus().installed, false);
  await assert.rejects(oUpdater.pCheck(), /репозитория/);
});
