const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emit(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'], forceNew: true });
    const timeout = setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('connect_error', reject);
  });
}

test('two players receive private hands and a synchronized game state', async (t) => {
  const port = 3300 + Math.floor(Math.random() * 300);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => server.kill());

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 5000);
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('서버가')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('error', reject);
  });

  const first = await connect(`http://127.0.0.1:${port}`);
  const second = await connect(`http://127.0.0.1:${port}`);
  t.after(() => first.close());
  t.after(() => second.close());

  let firstState;
  let secondState;
  first.on('gameState', (next) => { firstState = next; });
  second.on('gameState', (next) => { secondState = next; });

  const created = await emit(first, 'createRoom', { name: '테스터 1', playerId: 'player-one-token' });
  assert.equal(created.ok, true);
  const joined = await emit(second, 'joinRoom', { code: created.code, name: '테스터 2', playerId: 'player-two-token' });
  assert.equal(joined.ok, true);

  await wait(120);
  assert.equal(firstState.status, 'playing');
  assert.equal(secondState.status, 'playing');
  assert.equal(firstState.me.hand.length, 4);
  assert.equal(secondState.me.hand.length, 4);
  assert.equal(firstState.opponent.hand, undefined, 'opponent hand contents must remain private');
  assert.equal(secondState.opponent.hand, undefined, 'opponent hand contents must remain private');
  assert.equal(firstState.opponent.handCount, 4);
  assert.equal(firstState.me.board.length, 1);
  assert.equal(secondState.me.board.length, 1);

  const active = firstState.isMyTurn ? first : second;
  const activeState = firstState.isMyTurn ? firstState : secondState;
  const inactive = firstState.isMyTurn ? second : first;
  const drawn = await emit(active, 'gameAction', { type: 'draw' });
  assert.equal(drawn.ok, true);
  await wait(80);
  const afterDraw = firstState.isMyTurn ? firstState : secondState;
  assert.equal(afterDraw.me.drawUsed, true);
  assert.equal(afterDraw.me.hand.length, 5);

  const blocked = await emit(inactive, 'gameAction', { type: 'draw' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /상대의 턴/);
});
