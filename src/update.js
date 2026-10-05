// Самообновление агента, установленного из архива выпуска (layout.js).
//
// Раз в сутки (и через минуту после запуска) агент читает с сайта
// <updateUrl>latest.json и latest.json.sig. Подпись ed25519 проверяется
// открытым ключом, зашитым ниже: закрытый — только у того, кто выкладывает
// выпуск (scripts/agent-release.mjs), не в CI и не на сайте. Подделали
// сайт — подделать подпись нельзя.
//
// Версия новее — (если автообновление не выключено на странице настроек):
//   1. скачать архив своей платформы, сверить размер и sha256 из подписанного
//      latest.json;
//   2. распаковать в versions/<версия> (tar.js, без путей за пределы папки);
//   3. самопроверка: новый node запускает новый main.js --version — версия
//      совпала, нативная обёртка грузится; не так — не переключаемся;
//   4. переключить ссылку current на новую версию и завершиться — служба
//      (systemd / launchd / run.cmd) поднимет агент уже новой версии;
//   5. в versions остаются новая и предыдущая (для отката руками), старше — удаляются.
//
// Запуск из репозитория (нет package-info.json) — обновления нет.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, lstatSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { join } from 'node:path';
import { pipeline, rmSync } from './fsx.js';
import { sNodeFile } from './layout.js';
import { fWriteJson, vReadJson } from './store.js';
import { pExtractTarGz } from './tar.js';

// Открытый ключ подписи выпусков (scripts/agent-release.mjs keygen, 29.09.2026).
const S_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9pU6u5qmP7Gij7EV7LGXUB4nsibE2vuxgPBhfNqzl2Y=
-----END PUBLIC KEY-----
`;

const S_STATE = 'update.json';
const N_FIRST_CHECK_MS = 60_000;
const N_CHECK_EVERY_MS = 24 * 3600_000;

/** Сравнить версии x.y.z: <0, 0, >0. */
export function nCompareVersions(sA, sB) {
  const aA = String(sA).split('.').map(Number);
  const aB = String(sB).split('.').map(Number);
  for (let n = 0; n < 3; n += 1) {
    const nDiff = (aA[n] || 0) - (aB[n] || 0);
    if (nDiff) return nDiff;
  }
  return 0;
}

/** Проверить подпись latest.json и разобрать его. Бросает, если подпись не та. */
export function oVerifyManifest(sText, sSignatureBase64, sPublicKey = S_PUBLIC_KEY) {
  const oSignature = Buffer.from(String(sSignatureBase64).trim(), 'base64');
  if (!verify(null, Buffer.from(sText), createPublicKey(sPublicKey), oSignature)) {
    throw new Error('Подпись latest.json не сходится — обновление не принято');
  }
  const oManifest = JSON.parse(sText);
  if (oManifest.product !== 'kktsite-agent' || !/^\d+\.\d+\.\d+$/.test(oManifest.version) || typeof oManifest.files !== 'object') {
    throw new Error('latest.json не того формата');
  }
  return oManifest;
}

/**
 * Небольшой текст по http(s) — latest.json и подпись. Не fetch: его нет в
 * Node 12 (сборка для Windows 7), а у скачивания архива свой путь (pDownload).
 */
export function pFetchText(sUrl, nRedirects = 5) {
  return new Promise((fResolve, fReject) => {
    const oUrl = new URL(sUrl);
    const oGet = oUrl.protocol === 'https:' ? httpsGet : httpGet;
    const oReq = oGet(oUrl, { timeout: 30_000, headers: { 'Cache-Control': 'no-cache' } }, (oRes) => {
      if ([301, 302, 303, 307, 308].includes(oRes.statusCode) && oRes.headers.location && nRedirects > 0) {
        oRes.resume();
        fResolve(pFetchText(new URL(oRes.headers.location, oUrl).href, nRedirects - 1));
        return;
      }
      if (oRes.statusCode !== 200) {
        oRes.resume();
        fReject(new Error(`${sUrl}: HTTP ${oRes.statusCode}`));
        return;
      }
      const aChunks = [];
      oRes.on('data', (oChunk) => aChunks.push(oChunk));
      oRes.on('end', () => fResolve(Buffer.concat(aChunks).toString('utf8')));
      oRes.on('error', fReject);
    });
    oReq.on('timeout', () => oReq.destroy(new Error(`${sUrl}: нет ответа 30 с`)));
    oReq.on('error', fReject);
  });
}

/**
 * Скачать файл в sFile, считая sha256 и размер. Не fetch: встроенный undici
 * (Node 24) падает неперехватываемым assert(!this.paused), если сервер
 * закрывает соединение, пока поток стоит на паузе из-за медленной записи на
 * диск (29.09.2026: http.server по HTTP/1.0 — и агент упал посреди
 * обновления). Классический http/https с паузами справляется.
 */
function pDownload(oUrl, sFile, nRedirects = 5) {
  return new Promise((fResolve, fReject) => {
    const oGet = oUrl.protocol === 'https:' ? httpsGet : httpGet;
    const oReq = oGet(oUrl, { timeout: 60_000 }, (oRes) => {
      if ([301, 302, 303, 307, 308].includes(oRes.statusCode) && oRes.headers.location && nRedirects > 0) {
        oRes.resume();
        fResolve(pDownload(new URL(oRes.headers.location, oUrl), sFile, nRedirects - 1));
        return;
      }
      if (oRes.statusCode !== 200) {
        oRes.resume();
        fReject(new Error(`${oUrl.pathname}: HTTP ${oRes.statusCode}`));
        return;
      }
      const oHash = createHash('sha256');
      let nSize = 0;
      oRes.on('data', (oChunk) => { oHash.update(oChunk); nSize += oChunk.length; });
      pipeline(oRes, createWriteStream(sFile)).then(
        () => fResolve({ nSize, sSha256: oHash.digest('hex') }),
        fReject,
      );
    });
    oReq.on('timeout', () => oReq.destroy(new Error(`${oUrl.pathname}: нет ответа 60 с`)));
    oReq.on('error', fReject);
  });
}

/**
 * Переключить <корень>/current на versions/<версия>. На Linux и macOS —
 * новая ссылка и rename поверх старой (атомарно); на Windows junction поверх
 * существующего переименовать нельзя — удалить и создать.
 */
export function fSwitchCurrent(sRoot, sVersion) {
  const sCurrent = join(sRoot, 'current');
  if (process.platform === 'win32') {
    // lstat, а не existsSync: ссылка на удалённую папку «не существует», но мешает.
    let bLink = false;
    try { lstatSync(sCurrent); bLink = true; } catch { /* ещё нет */ }
    if (bLink) {
      try { unlinkSync(sCurrent); } catch { rmdirSync(sCurrent); } // junction удаляется как каталог — без содержимого
    }
    symlinkSync(join(sRoot, 'versions', sVersion), sCurrent, 'junction');
    return;
  }
  const sNew = join(sRoot, 'current.new');
  rmSync(sNew, { force: true });
  symlinkSync(join('versions', sVersion), sNew);
  renameSync(sNew, sCurrent);
}

export class Updater {
  /**
   * oLayout — установка (layout.js) или null. fExit — завершить процесс после
   * переключения (служба поднимет новую версию); в тестах — подмена.
   */
  constructor({ oLayout, fLog = () => {}, fExit = () => process.exit(0), sPublicKey = S_PUBLIC_KEY }) {
    this.oLayout = oLayout;
    this.fLog = fLog;
    this.fExit = fExit;
    this.sPublicKey = sPublicKey;
    this.sState = 'idle'; // idle | checking | downloading | installing | restarting
    this.oAvailable = null; // { version, released } — новее текущей
    this.sLastCheck = '';
    this.sLastError = '';
    this.nTimer = 0;
  }

  get bAuto() { return vReadJson(S_STATE, {}).auto !== false; }

  fSetAuto(bAuto) { fWriteJson(S_STATE, { ...vReadJson(S_STATE, {}), auto: Boolean(bAuto) }); }

  oStatus() {
    const oLayout = this.oLayout;
    return {
      installed: Boolean(oLayout),
      reason: oLayout ? '' : 'Агент запущен не из установки (из репозитория) — обновляется через git',
      version: oLayout?.sVersion ?? null,
      platform: oLayout?.sPlatform ?? null,
      updateUrl: oLayout?.sUpdateUrl ?? '',
      auto: this.bAuto,
      state: this.sState,
      available: this.oAvailable,
      lastCheck: this.sLastCheck,
      lastError: this.sLastError,
    };
  }

  /** Прочитать и проверить latest.json. Возвращает манифест. */
  async pCheck() {
    if (!this.oLayout) throw new Error(this.oStatus().reason);
    if (!this.oLayout.sUpdateUrl) throw new Error('Не задан адрес обновлений (updateUrl)');
    this.sState = 'checking';
    try {
      const sBase = this.oLayout.sUpdateUrl.replace(/\/?$/, '/');
      const [sText, sSignature] = await Promise.all([pFetchText(`${sBase}latest.json`), pFetchText(`${sBase}latest.json.sig`)]);
      const oManifest = oVerifyManifest(sText, sSignature, this.sPublicKey);
      this.sLastCheck = new Date().toISOString();
      this.sLastError = '';
      this.oAvailable = nCompareVersions(oManifest.version, this.oLayout.sVersion) > 0 && oManifest.files[this.oLayout.sPlatform]
        ? { version: oManifest.version, released: oManifest.released }
        : null;
      return oManifest;
    } catch (oError) {
      this.sLastError = oError.message;
      throw oError;
    } finally {
      if (this.sState === 'checking') this.sState = 'idle';
    }
  }

  /** Обновиться до версии из latest.json, если она новее. true — переключились. */
  async pInstall() {
    if (this.sState !== 'idle') throw new Error('Обновление уже идёт');
    const oManifest = await this.pCheck();
    if (!this.oAvailable) return false;
    const { sRoot, sPlatform, sVersion: sOld } = this.oLayout;
    const oEntry = oManifest.files[sPlatform];
    const sNew = oManifest.version;
    const sVersions = join(sRoot, 'versions');
    const sArchive = join(sVersions, `.download-${sNew}.tar.gz`);
    const sTmp = join(sVersions, `.tmp-${sNew}`);
    try {
      this.sState = 'downloading';
      this.fLog(`Обновление ${sOld} → ${sNew}: скачиваю ${oEntry.file}`);
      const { nSize, sSha256 } = await pDownload(new URL(oEntry.file, this.oLayout.sUpdateUrl.replace(/\/?$/, '/')), sArchive);
      if (nSize !== oEntry.size || sSha256 !== oEntry.sha256) {
        throw new Error('Скачанный архив не совпадает с подписанным latest.json (размер или sha256)');
      }

      this.sState = 'installing';
      rmSync(sTmp, { recursive: true, force: true });
      await pExtractTarGz(sArchive, sTmp, { nStrip: 1 });
      const sNode = join(sTmp, 'node', sNodeFile());
      const sMain = join(sTmp, 'app', 'src', 'main.js');
      const sSelfTest = execFileSync(sNode, [sMain, '--version'], { encoding: 'utf8', timeout: 60_000 }).trim();
      if (sSelfTest !== `kktsite-agent ${sNew}`) throw new Error(`Самопроверка новой версии: «${sSelfTest}»`);
      const sTarget = join(sVersions, sNew);
      rmSync(sTarget, { recursive: true, force: true });
      renameSync(sTmp, sTarget);
      fSwitchCurrent(sRoot, sNew);
      this.fLog(`Обновление ${sOld} → ${sNew}: переключено, перезапускаюсь`);
      this.fCleanup(sNew, sOld);
      this.sState = 'restarting';
      setTimeout(() => this.fExit(), 500).unref?.();
      return true;
    } catch (oError) {
      this.sLastError = `Обновление до ${sNew} не удалось: ${oError.message}`;
      this.fLog(this.sLastError);
      rmSync(sTmp, { recursive: true, force: true });
      this.sState = 'idle';
      throw oError;
    } finally {
      rmSync(sArchive, { force: true });
    }
  }

  /** Оставить в versions новую и предыдущую версии. */
  fCleanup(sKeepNew, sKeepOld) {
    const sVersions = join(this.oLayout.sRoot, 'versions');
    for (const sName of readdirSync(sVersions)) {
      if (sName === sKeepNew || sName === sKeepOld) continue;
      const sPath = join(sVersions, sName);
      try {
        if (lstatSync(sPath).isDirectory()) rmSync(sPath, { recursive: true, force: true });
      } catch (oError) {
        // Windows: файлы работающего процесса заняты — удалим в следующий раз.
        this.fLog(`Не удалить ${sPath}: ${oError.message}`);
      }
    }
  }

  /** Проверять обновления по расписанию; при автообновлении — ставить. */
  fStart() {
    if (!this.oLayout || this.nTimer) return;
    // Остатки прерванного обновления (агент выключили посреди скачивания).
    const sVersions = join(this.oLayout.sRoot, 'versions');
    for (const sName of readdirSync(sVersions)) {
      if (sName.startsWith('.download-') || sName.startsWith('.tmp-')) rmSync(join(sVersions, sName), { recursive: true, force: true });
    }
    const fTick = () => {
      const pRun = this.bAuto ? this.pInstall() : this.pCheck();
      pRun.catch((oError) => this.fLog(`Проверка обновлений: ${oError.message}`)).finally(() => {
        this.nTimer = setTimeout(fTick, N_CHECK_EVERY_MS);
        this.nTimer.unref?.();
      });
    };
    this.nTimer = setTimeout(fTick, N_FIRST_CHECK_MS);
    this.nTimer.unref?.();
  }

  fStop() { clearTimeout(this.nTimer); this.nTimer = 0; }
}
