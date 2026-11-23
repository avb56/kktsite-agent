// SOCKS5-сервер для ККТ (src/socks.js): кого пускает, куда ведёт, CONNECT до эха.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { bSocksClientAllowed, sSocksTarget, fSetSocksServer, oSocksStatus, fConfigureSocks } from '../src/socks.js';

test('SOCKS: пускает только сеть ККТ и этот ПК', () => {
  assert.ok(bSocksClientAllowed('192.168.137.111'));
  assert.ok(bSocksClientAllowed('::ffff:192.168.137.111'));
  assert.ok(bSocksClientAllowed('127.0.0.1'));
  assert.ok(!bSocksClientAllowed('192.168.9.50'), 'локальная сеть — нет: открытый прокси не нужен');
  assert.ok(!bSocksClientAllowed('192.168.1370.1'));
});

test('SOCKS: имена производителя — как в стеке kkt-core', () => {
  const sLong = 'ofd.masterfich.ru.abc.def.dev.kktlab.ru';
  assert.equal(sSocksTarget(sLong, true), sLong, 'со служебными данными — имя целиком');
  assert.equal(sSocksTarget(sLong, false), 'ofd.masterfich.ru', 'без них — хвост отрезан');
  assert.equal(sSocksTarget('dev.kktlab.ru', false), null, 'к производителю — отказ');
  assert.equal(sSocksTarget('ofd.ru', false), 'ofd.ru');
});

test('SOCKS: CONNECT по адресу и по имени до эха', async () => {
  const oEcho = net.createServer((o) => o.pipe(o)).listen(0, '127.0.0.1');
  await new Promise((f) => oEcho.once('listening', f));
  const nEcho = oEcho.address().port;
  const nPort = 18000 + Math.floor(Math.random() * 1000);
  fSetSocksServer(true, { vendorData: false, nPort });
  for (let i = 0; i < 50 && !oSocksStatus().listening; i++) await new Promise((f) => setTimeout(f, 20));
  assert.ok(oSocksStatus().listening);

  const pThrough = (aAddr) => new Promise((fResolve, fReject) => {
    const oSock = net.connect(nPort, '127.0.0.1');
    let aGot = Buffer.alloc(0);
    oSock.on('error', fReject);
    oSock.on('connect', () => oSock.write(Buffer.from([5, 1, 0])));
    oSock.on('data', (a) => {
      aGot = Buffer.concat([aGot, a]);
      if (aGot.length === 2) {
        assert.deepEqual([...aGot], [5, 0]);
        // Запрос и данные — одной посылкой, как может прислать ККТ.
        oSock.write(Buffer.concat([Buffer.from([5, 1, 0, ...aAddr, nEcho >> 8, nEcho & 255]), Buffer.from('ping')]));
      } else if (aGot.length >= 2 + 10 + 4) {
        assert.equal(aGot[3], 0, 'CONNECT — успех');
        assert.equal(aGot.subarray(12).toString(), 'ping');
        oSock.destroy();
        fResolve();
      }
    });
  });
  await pThrough([1, 127, 0, 0, 1]);
  await pThrough([3, 9, ...Buffer.from('localhost')]);

  fSetSocksServer(false);
  assert.equal(oSocksStatus().enabled, false);
  oEcho.close();
});

test('SOCKS на Windows: правило брандмауэра на порт для сети ККТ, при выключении — долой', async () => {
  const aCalls = [];
  let bFail = false;
  fConfigureSocks({ sPlatform: 'win32', fExec: async (sCmd, aArgs) => { aCalls.push([sCmd, ...aArgs].join(' ')); if (bFail && aArgs[2] === 'add') throw new Error('netsh: код выхода 1'); return ''; } });
  try {
    const nPort = 19000 + Math.floor(Math.random() * 1000);
    const pWait = async (f) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };
    fSetSocksServer(true, { nPort });
    await pWait(() => oSocksStatus().firewall);
    assert.equal(oSocksStatus().firewall, 'ok');
    assert.deepEqual(aCalls, [
      'netsh advfirewall firewall delete rule name=kktsite-agent SOCKS',
      `netsh advfirewall firewall add rule name=kktsite-agent SOCKS dir=in action=allow protocol=TCP localport=${nPort} remoteip=192.168.137.0/24 profile=any`,
    ]);
    aCalls.length = 0;
    fSetSocksServer(false);
    await pWait(() => aCalls.length);
    assert.deepEqual(aCalls, ['netsh advfirewall firewall delete rule name=kktsite-agent SOCKS']);
    // Без прав администратора — сервер работает, в состоянии — почему ККТ не достучится.
    bFail = true;
    fSetSocksServer(true, { nPort: nPort + 1 });
    await pWait(() => oSocksStatus().firewall);
    assert.ok(oSocksStatus().listening);
    assert.match(oSocksStatus().firewall, /брандмауэр Windows не открыл порт .*администратора/);
    fSetSocksServer(false);
  } finally {
    fConfigureSocks({ sPlatform: process.platform, fExec: async () => '' });
  }
});
