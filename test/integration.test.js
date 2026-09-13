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
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 5000);
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('서버가')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (chunk) => { output += chunk.toString(); });
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Server exited (${code}): ${output}`));
      }
    });
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
  assert.equal(firstState.status, 'setup');
  assert.equal(secondState.status, 'setup');
  assert.equal(firstState.me.hand.length, 3);
  assert.equal(secondState.me.hand.length, 3);

  // Both players place starter mob
  const p1Mob = firstState.me.hand.find(c => c.cardId !== 'nature-disaster' && c.cardId !== 'gyarados');
  const p2Mob = secondState.me.hand.find(c => c.cardId !== 'nature-disaster' && c.cardId !== 'gyarados');
  const p1Placed = await emit(first, 'gameAction', { type: 'play', cardUid: p1Mob.uid });
  assert.equal(p1Placed.ok, true);
  const p2Placed = await emit(second, 'gameAction', { type: 'play', cardUid: p2Mob.uid });
  assert.equal(p2Placed.ok, true);

  // Wait for coin-flip animation to finish and status to become playing
  await wait(2900);
  assert.equal(firstState.status, 'playing');
  assert.equal(secondState.status, 'playing');
  assert.equal(firstState.me.hand.length, 2);
  assert.equal(secondState.me.hand.length, 2);
  assert.equal(firstState.opponent.hand, undefined, 'opponent hand contents must remain private');
  assert.equal(secondState.opponent.hand, undefined, 'opponent hand contents must remain private');
  assert.equal(firstState.opponent.handCount, 2);
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
  assert.equal(afterDraw.me.hand.length, 3);

  const blocked = await emit(inactive, 'gameAction', { type: 'draw' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /상대의 턴/);
});
