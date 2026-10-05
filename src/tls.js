// HTTPS агента: самоподписанный сертификат, который агент выпускает сам.
//
// Зачем: страница кассы открыта по https, агент — в локальной сети. Браузеры
// с Private Network Access / Local Network Access пускают страницу к http-агенту
// по разрешению (как к COM и USB), остальные блокируют смешанный контент.
// Для них агент может слушать ещё и https (KKT_AGENT_HTTPS_PORT, по умолчанию
// порт http + 1), а сертификату доверяют один раз на кассовом ПК.
//
// Выключено по умолчанию: нужно не всем. Включается кнопкой на странице
// настроек (POST /api/v2/agentHttps) — сертификат выпускается тогда же, и
// агент сразу слушает https, без перезапуска. Сам агент сертификат не
// перевыпускает: после перевыпуска ему доверяют заново. Если в нём нет нового
// адреса ПК или подходит срок — страница показывает это и кнопку «Перевыпустить».
//
// Почему самоподписанный сертификат сервера, а не свой удостоверяющий центр
// (как mkcert): ключ УЦ лежал бы на кассовом ПК, и укравший его подделал бы
// для этого браузера любой сайт. Самоподписанному сертификату доверяют только
// для имён, что в нём записаны: localhost, имя ПК, его адреса в сети.
// Цена: появился новый адрес (сменили сеть) — сертификат перевыпускается, и
// доверять ему нужно заново.
//
// Без зависимостей и без openssl (на Windows его нет): ключ ECDSA P-256 и
// подпись — node:crypto, структура X.509 (DER) собирается здесь же.
// Файлы — в каталоге данных: agent.crt (публичный) и agent-key.pem (0600).

import * as crypto from 'node:crypto';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fWriteJson, fWriteText, sDataDir, vReadJson } from './store.js';

const S_CERT = 'agent.crt';
const S_KEY = 'agent-key.pem';
// Сведения о сертификате (имена, срок, отпечаток) — пишутся при выпуске: читать
// сам сертификат (X509Certificate) Node умеет только с 15.6, а сборка для
// Windows 7 — на Node 12.
const S_INFO = 'agent-cert.json';
const S_STATE = 'https.json';
// Сертификаты TLS-серверов macOS принимает не дольше 825 дней.
const N_VALID_DAYS = 825;
const N_RENEW_DAYS = 30;

// ——— DER ———

function aLength(nLength) {
  if (nLength < 0x80) return [nLength];
  const aBytes = [];
  for (let n = nLength; n > 0; n >>= 8) aBytes.unshift(n & 0xff);
  return [0x80 | aBytes.length, ...aBytes];
}
const tlv = (nTag, ...aParts) => {
  const oBody = Buffer.concat(aParts.map((v) => (Buffer.isBuffer(v) ? v : Buffer.from(v))));
  return Buffer.concat([Buffer.from([nTag, ...aLength(oBody.length)]), oBody]);
};
const seq = (...a) => tlv(0x30, ...a);
const set = (...a) => tlv(0x31, ...a);
const octets = (o) => tlv(0x04, o);
const bits = (o, nUnused = 0) => tlv(0x03, Buffer.from([nUnused]), o);
const bool = (b) => tlv(0x01, Buffer.from([b ? 0xff : 0x00]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, o) => tlv(0xa0 + n, o);

function integer(oBytes) {
  let o = Buffer.from(oBytes);
  while (o.length > 1 && o[0] === 0 && !(o[1] & 0x80)) o = o.subarray(1);
  if (o[0] & 0x80) o = Buffer.concat([Buffer.from([0]), o]); // положительное
  return tlv(0x02, o);
}

function oid(sOid) {
  const aParts = sOid.split('.').map(Number);
  const aBytes = [aParts[0] * 40 + aParts[1]];
  for (const nPart of aParts.slice(2)) {
    const aGroup = [nPart & 0x7f];
    for (let n = nPart >> 7; n > 0; n >>= 7) aGroup.unshift((n & 0x7f) | 0x80);
    aBytes.push(...aGroup);
  }
  return tlv(0x06, Buffer.from(aBytes));
}

function time(oDate) {
  const s = oDate.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; // YYYYMMDDHHMMSSZ
  // До 2050 года — UTCTime (две цифры года), с 2050 — GeneralizedTime (RFC 5280).
  return oDate.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2))) : tlv(0x18, Buffer.from(s));
}

function ipBytes(sIp) {
  if (sIp.includes(':')) {
    const [sHead, sTail = ''] = sIp.split('::');
    const aHead = sHead ? sHead.split(':') : [];
    const aTail = sIp.includes('::') ? (sTail ? sTail.split(':') : []) : [];
    const aGroups = [...aHead, ...Array(8 - aHead.length - aTail.length).fill('0'), ...aTail];
    return Buffer.from(aGroups.flatMap((s) => { const n = parseInt(s, 16); return [n >> 8, n & 0xff]; }));
  }
  return Buffer.from(sIp.split('.').map(Number));
}

const O_OID = {
  cn: '2.5.4.3',
  org: '2.5.4.10',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
  subjectKeyId: '2.5.29.14',
};

const extension = (sOid, bCritical, oValue) =>
  seq(oid(sOid), ...(bCritical ? [bool(true)] : []), octets(oValue));

/** Отпечаток SHA-256 в записи openssl / X509Certificate.fingerprint256: AB:CD:… */
const sFingerprint = (oDer) => createHash('sha256').update(oDer).digest('hex').toUpperCase().match(/../g).join(':');

/**
 * Самоподписанный сертификат сервера (X.509 v3, ECDSA P-256 / SHA-256):
 * { sCertPem, sKeyPem, oInfo }. aDns / aIps — имена и адреса в subjectAltName.
 */
export function oIssueCertificate({ aDns, aIps, oNow = new Date(), nDays = N_VALID_DAYS }) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const oSpki = publicKey.export({ type: 'spki', format: 'der' });
  const oName = seq(
    set(seq(oid(O_OID.org), utf8('kktsite-agent'))),
    set(seq(oid(O_OID.cn), utf8(`kktsite-agent ${aDns.find((s) => s !== 'localhost') || 'localhost'}`))),
  );
  const oNotBefore = new Date(oNow.getTime() - 3600_000); // час на расхождение часов
  const oNotAfter = new Date(oNow.getTime() + nDays * 86400_000);
  const oAltNames = seq(
    ...aDns.map((s) => tlv(0x82, Buffer.from(s, 'ascii'))),
    ...aIps.map((s) => tlv(0x87, ipBytes(s))),
  );
  const oAlgorithm = seq(oid(O_OID.ecdsaSha256));
  const oTbs = seq(
    explicit(0, integer([2])), // v3
    integer(randomBytes(16)),
    oAlgorithm,
    oName,
    seq(time(oNotBefore), time(oNotAfter)),
    oName,
    oSpki,
    explicit(3, seq(
      extension(O_OID.basicConstraints, true, seq()), // не УЦ: подписать другой сертификат им нельзя
      extension(O_OID.keyUsage, true, bits(Buffer.from([0x80]), 7)), // digitalSignature
      extension(O_OID.extKeyUsage, false, seq(oid(O_OID.serverAuth))),
      extension(O_OID.subjectAltName, false, oAltNames),
      extension(O_OID.subjectKeyId, false, octets(createHash('sha1').update(oSpki).digest())),
    )),
  );
  const oSignature = sign('sha256', oTbs, { key: privateKey, dsaEncoding: 'der' });
  const oCert = seq(oTbs, oAlgorithm, bits(oSignature));
  const sBase64 = oCert.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n$/, '');
  return {
    sCertPem: `-----BEGIN CERTIFICATE-----\n${sBase64}\n-----END CERTIFICATE-----\n`,
    sKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    oInfo: {
      aDns: [...aDns],
      aIps: [...aIps],
      sValidTo: new Date(Math.floor(oNotAfter.getTime() / 1000) * 1000).toISOString(), // в сертификате — до секунды
      sFingerprint: sFingerprint(oCert),
    },
  };
}

// ——— какие имена нужны и когда перевыпускать ———

/** Имена и адреса этого ПК: localhost, имя ПК, IPv4 и IPv6 всех интерфейсов. */
export function oLocalNames() {
  const sHost = hostname().toLowerCase();
  const aDns = [...new Set(['localhost', sHost, ...(sHost.includes('.') ? [] : [`${sHost}.local`])])]
    .filter((s) => /^[a-z0-9.-]+$/.test(s));
  const aIps = new Set(['127.0.0.1', '::1']);
  for (const [sIface, aAddrs] of Object.entries(networkInterfaces())) {
    // Мосты контейнеров — не адреса ПК в сети, касса по ним не ходит.
    if (/^(docker|br-|veth|virbr)/.test(sIface)) continue;
    for (const oAddr of aAddrs || []) {
      // fe80:: — адрес канала, в браузере им не пользуются.
      if (!oAddr.internal && !oAddr.address.startsWith('fe80:')) aIps.add(oAddr.address.split('%')[0]);
    }
  }
  return { aDns, aIps: [...aIps] };
}

/** Один и тот же IP в любой записи (::1 и 0:0:0:0:0:0:0:1) — одинаковый ключ. */
const sIpKey = (sIp) => ipBytes(sIp).toString('hex');

/** Почему сертификат надо перевыпустить, или '' — годится. oInfo — сведения о нём. */
export function sRenewReason(oInfo, { aDns, aIps }, oNow = new Date()) {
  const nLeft = (new Date(oInfo.sValidTo).getTime() - oNow.getTime()) / 86400_000;
  if (nLeft < N_RENEW_DAYS) return `истекает ${oInfo.sValidTo.slice(0, 10)}`;
  const sDns = new Set(oInfo.aDns.map((s) => s.toLowerCase()));
  for (const s of aDns) if (!sDns.has(s.toLowerCase())) return `нет имени ${s}`;
  const sIps = new Set(oInfo.aIps.map(sIpKey));
  for (const s of aIps) if (!sIps.has(sIpKey(s))) return `нет адреса ${s}`;
  return '';
}

const sCertPath = () => join(sDataDir(), S_CERT);
const sKeyPath = () => join(sDataDir(), S_KEY);

/**
 * Сведения о сертификате, выпущенном до agent-cert.json: прочитать из него
 * (Node 15.6+) и сохранить. На Node 12 прочитать нечем — null: такой
 * сертификат предлагается перевыпустить.
 */
function oInfoFromCertificate(sCert) {
  if (!crypto.X509Certificate) return null;
  const oCert = new crypto.X509Certificate(sCert);
  const aAlt = (oCert.subjectAltName || '').split(', ');
  const oInfo = {
    aDns: aAlt.filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4)),
    aIps: aAlt.filter((s) => s.startsWith('IP Address:')).map((s) => s.slice(11)),
    sValidTo: new Date(oCert.validTo).toISOString(),
    sFingerprint: oCert.fingerprint256,
  };
  fWriteJson(S_INFO, oInfo);
  return oInfo;
}

/** Сертификат из каталога данных: { sCert, sKey, oInfo } или null; oInfo — может быть null. */
function oLoadCertificate() {
  if (!existsSync(sCertPath()) || !existsSync(sKeyPath())) return null;
  const sCert = readFileSync(sCertPath(), 'utf8');
  const sKey = readFileSync(sKeyPath(), 'utf8');
  createPrivateKey(sKey); // битый ключ — ошибка здесь, а не при подключении
  return { sCert, sKey, oInfo: vReadJson(S_INFO, null) || oInfoFromCertificate(sCert) };
}

/**
 * Выпустить сертификат на имена этого ПК. Если был прежний — и на его имена:
 * ПК вернулся в прежнюю сеть — доверять заново не придётся.
 */
function oIssueAndSave() {
  const oNames = oLocalNames();
  let oOld = null;
  try { oOld = oLoadCertificate(); } catch { /* битый — выпускаем с нуля */ }
  // Адреса сравниваются по байтам: IPv6 из сертификата приходит в полной
  // записи (0:0:0:0:0:0:0:1), у интерфейсов — в краткой (::1).
  const sHave = new Set(oNames.aIps.map(sIpKey));
  for (const s of oOld?.oInfo?.aDns || []) if (!oNames.aDns.includes(s)) oNames.aDns.push(s);
  for (const s of oOld?.oInfo?.aIps || []) {
    if (!sHave.has(sIpKey(s))) {
      oNames.aIps.push(s);
      sHave.add(sIpKey(s));
    }
  }
  const { sCertPem, sKeyPem, oInfo } = oIssueCertificate(oNames);
  fWriteText(S_KEY, sKeyPem, 0o600);
  fWriteText(S_CERT, sCertPem, 0o644);
  fWriteJson(S_INFO, oInfo);
  return oLoadCertificate();
}

/**
 * HTTPS-слушатель агента. fHandler — тот же обработчик запросов, что у http.
 * Методы — для /api/v2/agentHttps и для запуска агента (pRestore).
 */
export function oCreateHttpsController({ fHandler, nPort, sHost, fLog = () => {} }) {
  let oServer = null;
  let sError = '';

  async function pListen(oLoaded) {
    if (oServer) {
      // Уже слушаем — подменить сертификат на лету, соединения не рвутся.
      oServer.setSecureContext({ key: oLoaded.sKey, cert: oLoaded.sCert });
      return;
    }
    const oNew = createServer({ key: oLoaded.sKey, cert: oLoaded.sCert }, fHandler);
    await new Promise((fResolve, fReject) => {
      oNew.once('error', fReject);
      oNew.listen(nPort, sHost, fResolve);
    });
    oServer = oNew;
    fLog(`Слушаю https://${sHost}:${oServer.address().port}/api/v2/`);
  }

  const bEnabled = () => Boolean(vReadJson(S_STATE, {}).enabled);

  return {
    get nPort() { return oServer?.address().port ?? nPort; },

    oStatus() {
      let oLoaded = null;
      let sProblem = '';
      try { oLoaded = oLoadCertificate(); } catch (oError) { sProblem = `Сертификат не прочитать: ${oError.message}`; }
      if (oLoaded) {
        const sReason = oLoaded.oInfo
          ? sRenewReason(oLoaded.oInfo, oLocalNames())
          : 'нет сведений о нём (выпущен прежней версией агента)';
        if (sReason) sProblem = `Сертификат пора перевыпустить: ${sReason}`;
      }
      return {
        enabled: bEnabled(),
        listening: Boolean(oServer),
        port: this.nPort,
        error: sError,
        problem: sProblem,
        certificate: oLoaded ? {
          fingerprint: oLoaded.oInfo?.sFingerprint ?? '',
          validTo: oLoaded.oInfo?.sValidTo ?? '',
          names: oLoaded.oInfo ? [...oLoaded.oInfo.aDns, ...oLoaded.oInfo.aIps] : [],
        } : null,
      };
    },

    /** Выпустить (перевыпустить) сертификат и включить https. */
    async pIssue() {
      const oLoaded = oIssueAndSave();
      fLog(`Сертификат HTTPS выпущен: ${sCertPath()}`);
      fWriteJson(S_STATE, { enabled: true });
      try {
        await pListen(oLoaded);
        sError = '';
      } catch (oError) {
        sError = oError.message;
        throw oError;
      }
    },

    /** Выключить https. Сертификат остаётся: включат снова — доверять заново не надо. */
    async pDisable() {
      fWriteJson(S_STATE, { enabled: false });
      sError = '';
      if (!oServer) return;
      await new Promise((f) => oServer.close(f));
      oServer.closeAllConnections?.();
      oServer = null;
      fLog('HTTPS выключен');
    },

    /** При запуске агента: был включён — слушать с тем сертификатом, что есть. */
    async pRestore() {
      if (!bEnabled()) return;
      try {
        const oLoaded = oLoadCertificate();
        if (!oLoaded) throw new Error('сертификата нет — выпустите его на странице настроек');
        await pListen(oLoaded);
        const sReason = oLoaded.oInfo ? sRenewReason(oLoaded.oInfo, oLocalNames()) : 'нет сведений о нём';
        if (sReason) fLog(`ВНИМАНИЕ: сертификат HTTPS пора перевыпустить (${sReason}) — кнопка на странице настроек`);
      } catch (oError) {
        sError = oError.message;
        fLog(`HTTPS не включился: ${oError.message}`);
      }
    },

    sCertificatePem() {
      return existsSync(sCertPath()) ? readFileSync(sCertPath(), 'utf8') : '';
    },

    close() { oServer?.close(); oServer?.closeAllConnections?.(); },
  };
}
