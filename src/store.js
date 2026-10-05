// Каталог данных агента: список ККТ, учётные записи. Обычные JSON-файлы —
// агент стоит на одном кассовом ПК, базы ему не нужно.
//
// Где лежит: KKT_AGENT_DATA, иначе стандартное место настроек приложения
// для ОС. Не рядом с программой: при обновлении каталог программы
// заменяется целиком, а настройки должны пережить обновление.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rmSync } from './fsx.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

const S_APP = 'kktsite-agent';

export function sDataDir() {
  if (process.env.KKT_AGENT_DATA) return process.env.KKT_AGENT_DATA;
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), S_APP);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', S_APP);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), S_APP);
}

/** Прочитать JSON-файл из каталога данных; нет файла — vDefault. */
export function vReadJson(sName, vDefault) {
  try {
    return JSON.parse(readFileSync(join(sDataDir(), sName), 'utf8'));
  } catch (oError) {
    if (oError.code === 'ENOENT') return vDefault;
    throw new Error(`Не прочитать ${join(sDataDir(), sName)}: ${oError.message}`);
  }
}

/**
 * Записать JSON-файл. Через временный файл и переименование: оборванная на
 * середине запись (выключили ПК) иначе оставила бы битый файл, и агент не
 * поднялся бы со списком ККТ.
 */
export function fWriteJson(sName, vData) {
  fWriteText(sName, JSON.stringify(vData, null, 2) + '\n');
}

/** Записать текстовый файл так же — через временный файл. */
export function fWriteText(sName, sText, nMode = 0o600) {
  const sDir = sDataDir();
  mkdirSync(sDir, { recursive: true, mode: 0o700 });
  const sPath = join(sDir, sName);
  rmSync(sPath + '.tmp', { force: true }); // mode применяется только к новому файлу
  writeFileSync(sPath + '.tmp', sText, { mode: nMode });
  renameSync(sPath + '.tmp', sPath);
}
