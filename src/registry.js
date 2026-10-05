// Список ККТ агента: devices.json в каталоге данных. ККТ, которые были
// подключены при остановке агента, подключаются снова при запуске.

import { AgentError, Device, oDriverSettings } from './device.js';
import { vReadJson, fWriteJson } from './store.js';

const S_FILE = 'devices.json';
// Идентификатор ККТ — по спецификации Web Requests (Device.id).
const R_ID = /^[a-zA-Z0-9_-]{1,16}$/;

export class Registry {
  constructor() {
    this.mDevices = new Map();
    for (const oDesc of vReadJson(S_FILE, [])) this.mDevices.set(String(oDesc.id), new Device(oDesc));
  }

  fSave() {
    fWriteJson(S_FILE, [...this.mDevices.values()].map((oDevice) => {
      const { lastError, isLock, hasLicense, ...oRest } = oDevice.oDescribe();
      return { ...oRest, isActive: oDevice.bWantActive };
    }));
  }

  aList() {
    return [...this.mDevices.values()].map((oDevice) => oDevice.oDescribe());
  }

  /**
   * ККТ по идентификатору (?deviceID); без него или по слову default — ККТ
   * по умолчанию, как у Web Requests.
   */
  oGet(sId) {
    if (sId && (sId !== 'default' || this.mDevices.has(sId))) {
      const oDevice = this.mDevices.get(String(sId));
      if (!oDevice) throw new AgentError(404, `Устройство с ID [${sId}] не найдено`);
      return oDevice;
    }
    const oDefault = [...this.mDevices.values()].find((oDevice) => oDevice.isDefault);
    if (!oDefault) throw new AgentError(404, 'Устройство по умолчанию не задано');
    return oDefault;
  }

  oAdd(oDesc) {
    // Web Requests требует id; агент без него берёт следующий свободный номер.
    const sId = String(oDesc.id || this.sNextId());
    if (!R_ID.test(sId)) {
      throw new AgentError(400, 'Идентификатор ККТ — от 1 до 16 символов: латинские буквы, цифры, «_» и «-»');
    }
    if (this.mDevices.has(sId)) throw new AgentError(409, `Устройство с ID [${sId}] уже есть`);
    const oDevice = new Device({ ...oDesc, id: sId, isActive: false });
    // Первая ККТ становится ККТ по умолчанию: иначе касса без ?deviceID
    // получала бы «устройство по умолчанию не задано» на единственной ККТ.
    if (oDevice.isDefault || !this.mDevices.size) this.fSetDefault(oDevice);
    this.mDevices.set(sId, oDevice);
    this.fSave();
    return oDevice;
  }

  async pUpdate(sId, oDesc) {
    // id, isActive и isDefault здесь не меняются — как у Web Requests: для них
    // свои методы (activateDevice, setDefaultDevice), id — удалить и добавить.
    const oDevice = this.oGet(sId);
    if (oDesc.name !== undefined) oDevice.name = String(oDesc.name);
    if (oDesc.otherSettings) oDevice.otherSettings = { ...oDevice.otherSettings, ...oDesc.otherSettings };
    if (oDesc.connectionSettings) {
      const oNew = { ...oDevice.connectionSettings, ...oDesc.connectionSettings };
      oDriverSettings(oNew); // неизвестный канал связи — 400 до отключения ККТ
      // Настройки подключения вступают в силу только переподключением, и
      // только если они поменялись: иначе сохранение имени рвало бы печать.
      if (JSON.stringify(oNew) !== JSON.stringify(oDevice.connectionSettings)) {
        const bWasActive = Boolean(oDevice.oHandle);
        await oDevice.pDeactivate();
        oDevice.connectionSettings = oNew;
        this.fSave();
        if (bWasActive) await oDevice.pActivate();
      }
    }
    this.fSave();
    return oDevice;
  }

  async pDelete(sId) {
    const oDevice = this.oGet(sId);
    await oDevice.pDeactivate();
    this.mDevices.delete(oDevice.id);
    this.fSave();
  }

  async pSetActive(sId, bActive) {
    const oDevice = this.oGet(sId);
    try {
      if (bActive) await oDevice.pActivate();
      else await oDevice.pDeactivate();
    } finally {
      this.fSave();
    }
    return oDevice;
  }

  /**
   * Дождаться, когда все ККТ простаивают: очередь пуста, ничего не
   * выполняется и не заблокировано. Перед перезапуском на обновление —
   * чтобы не оборвать чек. Не дождались за nTimeoutMs — false.
   */
  async pWaitIdle(nTimeoutMs = 10 * 60_000) {
    const nUntil = Date.now() + nTimeoutMs;
    const bIdle = () => [...this.mDevices.values()].every((o) => !o.bPumping && !o.aWaiting.length && !o.oBlock);
    while (Date.now() < nUntil) {
      if (bIdle()) {
        // И то, что уже в цепочке драйвера (синхронные /operations), — тоже.
        await Promise.all([...this.mDevices.values()].map((o) => o.pSerial(() => {})));
        if (bIdle()) return true;
      }
      await new Promise((f) => setTimeout(f, 500));
    }
    return false;
  }

  /** Подключить ККТ, которые были подключены при прошлой остановке. */
  async pRestore(fLog) {
    for (const oDevice of this.mDevices.values()) {
      if (!oDevice.bWantActive) continue;
      await oDevice.pActivate().then(
        () => fLog(`ККТ [${oDevice.id}] ${oDevice.name}: подключена`),
        (oError) => {
          // Остаётся «хотят подключённой»: не вышло сейчас (ККТ выключена) —
          // подключат руками или при следующем запуске.
          oDevice.bWantActive = true;
          fLog(`ККТ [${oDevice.id}] ${oDevice.name}: ${oError.message}`);
        },
      );
    }
  }

  /** setDefaultDevice: с этой ККТ будет работать касса. */
  fSetDefaultById(sId) {
    const oDevice = this.mDevices.get(String(sId ?? ''));
    if (!oDevice) throw new AgentError(404, `Устройство с ID [${sId ?? ''}] не найдено`);
    this.fSetDefault(oDevice);
    this.fSave();
    return oDevice;
  }

  fSetDefault(oDevice) {
    for (const oOther of this.mDevices.values()) oOther.isDefault = false;
    oDevice.isDefault = true;
  }

  sNextId() {
    let n = 1;
    while (this.mDevices.has(String(n))) n += 1;
    return String(n);
  }
}
