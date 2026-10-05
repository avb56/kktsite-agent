// Учётные записи агента — basic-авторизация, как у «АТОЛ. Web Requests».
//
// В отличие от него авторизация необязательна: пока нет ни одной учётки,
// агент открыт (кассовый ПК с одним кассиром, агент слушает только его).
// Первая заведённая учётка включает проверку. Учётки заводят на странице
// настроек (вкладка «Доступ», /api/v2/agentUsers) или с консоли:
//   kktsite-agent users add <имя> <пароль>
//
// Пароли хранятся хешем scrypt с солью — файл users.json лежит в каталоге
// данных, и прочитать его может тот, кто сидит за ПК.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { vReadJson, fWriteJson } from './store.js';

const S_FILE = 'users.json';

function oLoad() {
  return vReadJson(S_FILE, {});
}

function sHash(sPassword, sSalt = randomBytes(16).toString('hex')) {
  return `scrypt:${sSalt}:${scryptSync(sPassword, sSalt, 32).toString('hex')}`;
}

export const aUserNames = () => Object.keys(oLoad()).sort();

export const bAuthEnabled = () => aUserNames().length > 0;

export function fAddUser(sName, sPassword) {
  if (!/^[\w.@-]{1,64}$/.test(sName)) throw new Error('Имя — латиница, цифры, . _ @ -, до 64 символов');
  if (!sPassword || sPassword.length < 8) throw new Error('Пароль — не короче 8 символов');
  fWriteJson(S_FILE, { ...oLoad(), [sName]: sHash(sPassword) });
}

export function fDeleteUser(sName) {
  const { [sName]: sDropped, ...oRest } = oLoad();
  if (!sDropped) throw new Error(`Учётной записи ${sName} нет`);
  fWriteJson(S_FILE, oRest);
}

/** Проверить заголовок Authorization: Basic …. true — пустить. */
export function bCheckBasic(sHeader) {
  const oUsers = oLoad();
  if (!Object.keys(oUsers).length) return true;
  const aMatch = /^Basic\s+(.+)$/i.exec(sHeader || '');
  if (!aMatch) return false;
  const sDecoded = Buffer.from(aMatch[1], 'base64').toString('utf8');
  const nColon = sDecoded.indexOf(':');
  if (nColon < 0) return false;
  const sStored = oUsers[sDecoded.slice(0, nColon)];
  if (!sStored) return false;
  const [, sSalt, sExpected] = sStored.split(':');
  const aGot = Buffer.from(sHash(sDecoded.slice(nColon + 1), sSalt).split(':')[2], 'hex');
  const aWant = Buffer.from(sExpected, 'hex');
  return aGot.length === aWant.length && timingSafeEqual(aGot, aWant);
}
