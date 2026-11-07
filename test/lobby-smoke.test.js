'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { io } = require('socket.io-client');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited before becoming healthy.');
    try {
      const response = await fetch(url + '/health');
      if (response.ok) return response.json();
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become healthy in time.');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'], reconnection: false, timeout: 5000 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function ack(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const callback = (error, result) => {
      if (error) reject(error);
      else resolve(result);
    };
    if (payload === undefined) socket.timeout(3000).emit(event, callback);
    else socket.timeout(3000).emit(event, payload, callback);
  });
}

function nextEvent(socket, event, predicate = () => true, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error('Timed out waiting for ' + event)); }, timeout);
    function handler(value) {
      if (!predicate(value)) return;
      clearTimeout(timer); socket.off(event, handler); resolve(value);
    }
    socket.on(event, handler);
  });
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

 test('lobby lifecycle and host-authoritative game relay', async t => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), CORS_ORIGIN: '*' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  const sockets = [];
  t.after(() => {
    sockets.forEach(socket => { try { socket.disconnect(); } catch (_) {} });
    child.kill('SIGTERM');
  });

  await waitForHealth(url, child);
  const host = await connect(url); sockets.push(host);
  const created = await ack(host, 'create-lobby', { name: 'Host' });
  assert.equal(created.ok, true, serverOutput);
  assert.match(created.lobby.code, /^[A-HJ-NP-Z]{4}$/);
  assert.equal(created.lobby.players.length, 1);

  const guest = await connect(url); sockets.push(guest);
  const hostUpdated = nextEvent(host, 'lobby-updated', lobby => lobby.players.length === 2);
  const joined = await ack(guest, 'join-lobby', { code: created.lobby.code.toLowerCase(), name: 'Guest' });
  assert.equal(joined.ok, true, serverOutput);
  assert.equal(joined.lobby.players.length, 2);
  await hostUpdated;

  const statePacket = nextEvent(guest, 'game-event', packet => packet.event === 'st');
  host.emit('game-event', { event: 'st', data: { tick: 42 } });
  assert.deepEqual((await statePacket).data, { tick: 42 });

  const inputPacket = nextEvent(host, 'game-event', packet => packet.event === 'in');
  guest.emit('game-event', { event: 'in', data: { mx: 1, my: 0 } });
  assert.deepEqual((await inputPacket).data, { mx: 1, my: 0 });

  let unauthorizedStateReceived = false;
  const unauthorizedHandler = packet => { if (packet.event === 'st') unauthorizedStateReceived = true; };
  host.on('game-event', unauthorizedHandler);
  guest.emit('game-event', { event: 'st', data: { cheat: true } });
  await delay(180);
  host.off('game-event', unauthorizedHandler);
  assert.equal(unauthorizedStateReceived, false, 'non-host state snapshots must not reach the host');

  const onePlayerLeft = nextEvent(host, 'lobby-updated', lobby => lobby.players.length === 1);
  assert.equal((await ack(guest, 'leave-lobby')).ok, true);
  await onePlayerLeft;
  guest.disconnect();

  const guest2 = await connect(url); sockets.push(guest2);
  const hostLeaves = nextEvent(guest2, 'lobby-closed');
  assert.equal((await ack(host, 'get-lobbies')).length, 1);
  assert.equal((await ack(host, 'leave-lobby')).ok, true);
  const closed = await hostLeaves;
  assert.equal(closed.code, created.lobby.code);
  await delay(100);
  const health = await (await fetch(url + '/health')).json();
  assert.equal(health.activeLobbies, 0);
 });
