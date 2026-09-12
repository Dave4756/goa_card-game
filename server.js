const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const CARD_DATA = require('./data/cards.json');
const RULES = require('./data/rules.json');

const cards = new Map(CARD_DATA.cards.map((card) => [card.id, card]));
const rooms = new Map();
let nextInstanceNumber = 1;
const matchmakingQueue = [];

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling']
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/data', express.static(path.join(__dirname, 'data')));
app.use('/image', express.static(path.join(__dirname, 'image')));

app.get('/image.png', (_req, res) => {
  const customBg = path.join(__dirname, 'image.png');
  const innerCustom = path.join(__dirname, 'image', 'image.png');
  const bgPng = path.join(__dirname, 'image', 'background.png');
  if (fs.existsSync(customBg)) return res.sendFile(customBg);
  if (fs.existsSync(innerCustom)) return res.sendFile(innerCustom);
  if (fs.existsSync(bgPng)) return res.sendFile(bgPng);
  res.status(404).send('Background image not found');
});

app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, rooms: rooms.size, queue: matchmakingQueue.length }));

function makeId(prefix = 'c') {
  return `${prefix}_${nextInstanceNumber++}_${crypto.randomBytes(3).toString('hex')}`;
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 16) throw new Error('닉네임은 2~16자로 입력해 주세요.');
  return name;
}

function newPlayer({ id, name, socketId, seat, customDeck }) {
  return {
    id,
    name,
    socketId,
    connected: true,
    seat,
    deck: [],
    customDeck: Array.isArray(customDeck) ? customDeck : null,
    hand: [],
    board: [],
    trash: [],
    fieldEffect: null,
    drawUsed: false
  };
}

function createCard(cardId) {
  const definition = cards.get(cardId);
  if (!definition) throw new Error(`알 수 없는 카드: ${cardId}`);
  if (definition.type !== 'mob') {
    return { uid: makeId('i'), cardId };
  }
  return {
    uid: makeId('m'),
    cardId,
    hp: definition.hp,
    maxHp: definition.hp,
    attachments: [],
    statuses: { confusion: false, burn: false, sleep: 0 },
    stacks: { overcharge: 0, fuel: 0 },
    modifiers: {
      damageBonus: 0,
      nextDamageMultiplier: 1,
      forceTarget: false,
      nextAttackHalf: false,
      nextAttackWeak: false
    },
    skillUsed: false,
    lastSkill: null,
    lastTargetId: null,
    placedTurn: null,
    solarTurns: 0,
    photosynthesisBonus: 0
  };
}

function buildDeck(customCardIds) {
  if (Array.isArray(customCardIds) && customCardIds.length >= 10) {
    const validCards = customCardIds
      .filter((id) => cards.has(id) && !cards.get(id).hidden)
      .slice(0, 20);
    // 카드별 장수 제한: 같은 카드 최대 2장, 자연재해??는 최대 1장
    const counts = new Map();
    const filtered = [];
    for (const id of validCards) {
      const currentCount = counts.get(id) || 0;
      const maxLimit = id === 'nature-disaster' ? 1 : 2;
      if (currentCount < maxLimit) {
        counts.set(id, currentCount + 1);
        filtered.push(id);
      }
    }
    // 시작 몹으로 쓰일 수 있는 일반 몹 카드가 최소 1장 이상 있어야 함 (자연재해, 갸라도스 제외)
    const mobCandidates = filtered.filter((id) => {
      const def = cards.get(id);
      return def && def.type === 'mob' && id !== 'nature-disaster' && id !== 'gyarados';
    });
    if (mobCandidates.length > 0 && filtered.length >= 10) {
      return shuffle(filtered.map(createCard));
    }
  }

  // 20장 기본 덱 (각 카드 최대 2장)
  const defaultList = [
    'jeonjangyeon', 'face-fish', 'gyarados', 'snorlax', 'mecha', 'jongchu', 'biker',
    'patience', 'patience', 'learning', 'sociability', 'sociability',
    'draw-one-mob', 'draw-one-mob', 'cleanse', 'cleanse', 'bag', 'bag', 'positive-negative', 'eraser'
  ];
  return shuffle(defaultList.map(createCard));
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function cardOf(instance) {
  return cards.get(instance.cardId);
}

function playerBySeat(room, seat) {
  return room.players[seat];
}

function opponentOf(room, player) {
  return playerBySeat(room, player.seat === 0 ? 1 : 0);
}

function ownerOfMob(room, uid) {
  for (const player of room.players) {
    const mob = player.board.find((entry) => entry.uid === uid);
    if (mob) return { player, mob };
  }
  return null;
}

function log(room, text, kind = 'system') {
  room.logs.unshift({ id: makeId('l'), text, kind, at: Date.now() });
  room.logs = room.logs.slice(0, 40);
}

function effect(room, payload) {
  const event = { id: makeId('e'), at: Date.now(), ...payload };
  io.to(room.code).emit('gameEffect', event);
}

function coin(room, context) {
  const heads = Math.random() < 0.5;
  const result = heads ? '앞면' : '뒷면';
  effect(room, { type: 'coin', result, heads, title: context || '동전 던지기' });
  log(room, `${context || '동전'}: ${result}`, 'coin');
  return heads;
}

function publicMob(mob) {
  return {
    uid: mob.uid,
    cardId: mob.cardId,
    hp: mob.hp,
    maxHp: mob.maxHp,
    attachments: [...mob.attachments],
    statuses: { ...mob.statuses },
    stacks: { ...mob.stacks },
    modifiers: {
      damageBonus: mob.modifiers.damageBonus,
      nextDamageMultiplier: mob.modifiers.nextDamageMultiplier,
      forceTarget: mob.modifiers.forceTarget,
      nextAttackHalf: mob.modifiers.nextAttackHalf,
      nextAttackWeak: mob.modifiers.nextAttackWeak
    },
    skillUsed: mob.skillUsed,
    solarTurns: mob.solarTurns,
    placedTurn: mob.placedTurn
  };
}

function publicHand(card) {
  const definition = cardOf(card);
  if (definition.type === 'mob') return publicMob(card);
  return { uid: card.uid, cardId: card.cardId };
}

function publicTrash(card) {
  return { uid: card.uid, cardId: card.cardId };
}

function viewFor(room, seat) {
  const me = playerBySeat(room, seat);
  const opponent = opponentOf(room, me);
  const common = (player, isMe) => ({
    name: player.name,
    connected: player.connected,
    board: player.board.map(publicMob),
    fieldEffect: player.fieldEffect,
    deckCount: player.deck.length,
    trash: player.trash.map(publicTrash),
    hand: isMe ? player.hand.map(publicHand) : undefined,
    handCount: player.hand.length,
    drawUsed: isMe ? player.drawUsed : undefined
  });
  return {
    roomCode: room.code,
    status: room.status,
    turnNumber: room.turnNumber,
    activeSeat: room.activeSeat,
    isMyTurn: (room.status === 'playing' && room.activeSeat === seat) || (room.status === 'setup' && me.board.length === 0),
    me: common(me, true),
    opponent: opponent ? common(opponent, false) : null,
    logs: room.logs,
    winner: room.winner === null ? null : room.winner === seat ? 'me' : 'opponent',
    rules: {
      maxBoardSize: RULES.maxBoardSize,
      drawsPerTurn: RULES.drawsPerTurn,
      skillsPerMobPerTurn: RULES.skillsPerMobPerTurn
    }
  };
}

function emitState(room) {
  room.players.forEach((player) => {
    if (player.socketId) io.to(player.socketId).emit('gameState', viewFor(room, player.seat));
  });
}

function playerForSocket(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return null;
  const player = room.players.find((entry) => entry.id === socket.data.playerId);
  if (!player) return null;
  return { room, player };
}

function startCoinFlipAndGame(room) {
  room.status = 'coin-flip';
  const heads = Math.random() < 0.5;
  const firstSeat = heads ? 0 : 1;
  const firstPlayer = playerBySeat(room, firstSeat);
  room.activeSeat = firstSeat;

  log(room, `동전 던지기: ${heads ? '앞면' : '뒷면'}! ${firstPlayer.name} 님이 선공입니다.`, 'coin');
  effect(room, {
    type: 'first-coin',
    heads,
    result: heads ? '앞면' : '뒷면',
    firstSeat,
    firstName: firstPlayer.name,
    title: '선공 결정 동전 던지기!',
    text: `${heads ? '앞면' : '뒷면'}! ${firstPlayer.name} 님의 선공!`
  });
  emitState(room);

  setTimeout(() => {
    if (room.status !== 'coin-flip') return;
    room.status = 'playing';
    room.turnNumber = 1;
    log(room, `대전 시작! ${firstPlayer.name} 님의 선공입니다.`, 'start');
    beginTurn(room, firstPlayer);
    emitState(room);
  }, 2600);
}

function startGame(room) {
  room.status = 'setup';
  room.turnNumber = 0;
  room.winner = null;
  room.healingForbidden = false;
  room.healingSourceUid = null;
  room.players.forEach((player) => {
    player.deck = buildDeck(player.customDeck);
    player.hand = [];
    player.board = [];
    player.trash = [];
    player.fieldEffect = null;
    player.drawUsed = false;

    // 시작 패 3장: 최소 1장은 일반 몹 카드 보장 (자연재해, 갸라도스 제외)
    const mobCandidates = player.deck
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => {
        const definition = cardOf(entry);
        return definition.type === 'mob' && definition.id !== 'nature-disaster' && definition.id !== 'gyarados';
      });
    const starterIndex = mobCandidates.length > 0
      ? mobCandidates[Math.floor(Math.random() * mobCandidates.length)].index
      : 0;
    const [guaranteedMob] = player.deck.splice(starterIndex, 1);
    player.hand.push(guaranteedMob);

    // 나머지 2장 드로우 (총 3장)
    for (let count = 0; count < 2; count += 1) {
      drawCard(room, player);
    }
  });

  log(room, '시작 몹 배치 단계입니다. 손패에서 시작 몹을 필드에 배치하세요.', 'start');
  effect(room, {
    type: 'setup-phase',
    title: '시작 몹 배치',
    text: '손패에서 몹 카드 1장을 필드에 배치하세요!'
  });
}

function drawCard(room, player, onlyMob = false) {
  const candidates = player.deck
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !onlyMob || cardOf(entry).type === 'mob');
  if (!candidates.length) return null;
  const selected = onlyMob ? candidates[Math.floor(Math.random() * candidates.length)] : { index: player.deck.length - 1 };
  const [card] = player.deck.splice(selected.index, 1);
  player.hand.push(card);
  return card;
}

function addOvercharge(room, player, mob, amount, reason = '과충전') {
  const multiplier = player.fieldEffect === 'electric-field' ? 2 : 1;
  const before = mob.stacks.overcharge;
  mob.stacks.overcharge = Math.min(RULES.overchargeCap, before + amount * multiplier);
  const gained = mob.stacks.overcharge - before;
  if (gained) {
    effect(room, { type: 'stack', vfx: 'electric', targetId: mob.uid, amount: gained, title: reason });
    log(room, `${cardOf(mob).name}의 과충전 +${gained}`, 'stack');
  }
}

function canHeal(room, mob) {
  return !room.healingForbidden || room.healingSourceUid === mob.uid;
}

function heal(room, mob, amount, title = '회복') {
  if (!amount || !canHeal(room, mob) || mob.hp <= 0) return 0;
  const restored = Math.max(0, Math.min(amount, mob.maxHp - mob.hp));
  mob.hp += restored;
  if (restored) {
    effect(room, { type: 'heal', vfx: 'heal', targetId: mob.uid, amount: restored, title });
  }
  return restored;
}

function rawDamage(mob, owner, amount) {
  let result = amount;
  const definition = cardOf(mob);
  if (definition.id === 'mecha') result += mob.stacks.overcharge * 10;
  if (definition.id === 'knight' && owner.board.length === 1) result *= 0.5;
  if (definition.id === 'taekwondo') result *= 0.5;
  result -= mob.attachments.filter((id) => id === 'patience').length * 15;
  result *= mob.modifiers.nextDamageMultiplier;
  mob.modifiers.nextDamageMultiplier = 1;
  return Math.max(0, Math.floor(result));
}

function applySingleDamage(room, owner, mob, amount, options = {}) {
  if (mob.hp <= 0 || !amount) return { dealt: 0, evaded: false };
  if (options.attackSkill && cardOf(mob).id === 'face-fish') {
    const heads = coin(room, `${cardOf(mob).name}의 회피 판정`);
    if (heads) {
      effect(room, { type: 'evade', vfx: 'splash', targetId: mob.uid, title: '회피 성공!' });
      return { dealt: 0, evaded: true };
    }
  }
  const dealt = rawDamage(mob, owner, amount);
  mob.hp -= dealt;
  if (dealt) effect(room, { type: 'damage', vfx: options.vfx || 'impact', targetId: mob.uid, amount: dealt, title: options.title || '피해' });
  return { dealt, evaded: false };
}

function damage(room, owner, mob, amount, options = {}) {
  if (mob.hp <= 0) return 0;
  let dealt = 0;
  if (!options.noRedirect && cardOf(mob).id !== 'hair') {
    const index = owner.board.findIndex((entry) => entry.uid === mob.uid);
    const guardians = [owner.board[index - 1], owner.board[index + 1]]
      .filter((entry) => entry && cardOf(entry).id === 'hair' && entry.hp > 0);
    if (guardians.length) {
      const guardian = guardians[0];
      const redirected = Math.ceil(amount * 0.5);
      const remaining = amount - redirected;
      const protectedResult = applySingleDamage(room, owner, mob, remaining, options);
      const guardianResult = applySingleDamage(room, owner, guardian, redirected, { ...options, noRedirect: true, title: '피해 분담' });
      return protectedResult.dealt + guardianResult.dealt;
    }
  }
  dealt = applySingleDamage(room, owner, mob, amount, options).dealt;
  return dealt;
}

function outgoingDamage(sourceOwner, source, base) {
  let amount = base + source.modifiers.damageBonus;
  amount += source.attachments.filter((id) => id === 'learning').length * 10;
  if (cardOf(source).id === 'knight' && sourceOwner.board.length === 1) amount *= 2;
  if (source.modifiers.nextAttackHalf) amount *= 0.5;
  if (source.modifiers.nextAttackWeak) amount *= 0.5;
  return Math.max(0, Math.floor(amount));
}

function consumeNextAttackModifiers(source) {
  source.modifiers.nextAttackHalf = false;
  source.modifiers.nextAttackWeak = false;
}

function trashMob(player, mob) {
  player.trash.push({ uid: mob.uid, cardId: mob.cardId });
  mob.attachments.forEach((cardId) => player.trash.push(createCard(cardId)));
}

function removeDead(room) {
  let removed = false;
  for (const player of room.players) {
    const dead = player.board.filter((mob) => mob.hp <= 0);
    if (!dead.length) continue;
    player.board = player.board.filter((mob) => mob.hp > 0);
    dead.forEach((mob) => {
      trashMob(player, mob);
      log(room, `${cardOf(mob).name} 카드가 트레쉬로 이동했습니다.`, 'death');
      effect(room, { type: 'defeat', vfx: 'shatter', targetId: mob.uid, title: `${cardOf(mob).name} 격파` });
    });
    removed = true;
  }
  if (removed) checkVictory(room);
  return removed;
}

function checkVictory(room) {
  if (room.status !== 'playing') return;
  const empty = room.players.filter((player) => player.board.length === 0);
  if (!empty.length) return;
  if (empty.length === 2) {
    room.status = 'finished';
    room.winner = null;
    log(room, '양쪽 필드가 비어 무승부입니다.', 'end');
    effect(room, { type: 'end', title: '무승부', text: '양쪽 필드가 비었습니다.' });
    return;
  }
  const loser = empty[0];
  room.status = 'finished';
  room.winner = loser.seat === 0 ? 1 : 0;
  const winner = playerBySeat(room, room.winner);
  log(room, `${winner.name} 님의 승리!`, 'end');
  effect(room, { type: 'end', title: '승리', text: `${winner.name} 님이 승리했습니다.` });
}

function maybeAwaken(room, player, mob) {
  if (mob.cardId !== 'jeonjangyeon') return;
  const required = ['patience', 'learning', 'sociability'];
  if (!required.every((id) => mob.attachments.includes(id))) return;
  mob.cardId = 'awakened';
  mob.maxHp = cards.get('awakened').hp;
  mob.hp = mob.maxHp;
  effect(room, { type: 'special', vfx: 'awakening', targetId: mob.uid, title: '각성!', text: '각성 리즈시절 전장연이 등장했습니다.' });
  log(room, `${player.name}의 전장연이 각성 리즈시절 전장연으로 진화했습니다!`, 'special');
}

function evolveFaceFish(room, player, mob) {
  if (mob.cardId !== 'face-fish') throw new Error('인면어 전장연만 진화할 수 있습니다.');
  const hpRatio = mob.hp / Math.max(mob.maxHp, 1);
  mob.cardId = 'gyarados';
  mob.maxHp = cards.get('gyarados').hp;
  mob.hp = Math.max(1, Math.ceil(mob.maxHp * hpRatio));
  effect(room, { type: 'special', vfx: 'tidal', targetId: mob.uid, title: '진화!', text: '갸라도스 전장연이 등장했습니다.' });
  log(room, `${player.name}의 인면어 전장연이 갸라도스 전장연으로 진화했습니다!`, 'special');
}

function applyBurn(room, player, mob) {
  if (!mob.statuses.burn) return;
  damage(room, player, mob, 20, { title: '화상', vfx: 'fire', noRedirect: true });
  const heads = coin(room, `${cardOf(mob).name}의 화상 판정`);
  if (heads) {
    mob.statuses.burn = false;
    log(room, `${cardOf(mob).name}의 화상이 사라졌습니다.`, 'status');
  }
}

function beginTurn(room, player) {
  if (room.status !== 'playing') return;
  player.drawUsed = false;
  player.board.forEach((mob) => { mob.skillUsed = false; });
  log(room, `${player.name} 님의 ${room.turnNumber}턴`, 'turn');
  effect(room, {
    type: 'turn-change',
    activeSeat: player.seat,
    activeName: player.name,
    turnNumber: room.turnNumber,
    title: `${player.name} 님의 턴!`,
    text: `TURN ${room.turnNumber}`
  });

  [...player.board].forEach((mob) => applyBurn(room, player, mob));
  removeDead(room);
  if (room.status !== 'playing') return;

  [...player.board].forEach((mob) => {
    const definition = cardOf(mob);
    if (definition.id === 'jongchu') {
      const index = player.board.findIndex((entry) => entry.uid === mob.uid);
      [player.board[index - 1], mob, player.board[index + 1]].filter(Boolean)
        .forEach((target) => addOvercharge(room, player, target, 1, '전기쥐'));
    }
    if (definition.id === 'biker') {
      mob.stacks.fuel += 1;
      effect(room, { type: 'stack', vfx: 'fire', targetId: mob.uid, amount: 1, title: '과열된 연료' });
    }
    if (definition.id === 'jongbaragi') {
      heal(room, mob, 50 + mob.photosynthesisBonus, '광합성');
      mob.maxHp += 10;
      mob.photosynthesisBonus += 10;
    }
    if (mob.attachments.includes('sociability')) heal(room, mob, 10, '사회 친화력');
  });

  [...player.board].forEach((mob) => {
    if (!mob.solarTurns) return;
    mob.solarTurns -= 1;
    if (mob.solarTurns !== 0) return;
    const enemy = opponentOf(room, player);
    const target = [...enemy.board].sort((a, b) => a.hp - b.hp)[0];
    if (!target) return;
    const amount = outgoingDamage(player, mob, 300);
    const dealt = damage(room, enemy, target, amount, { attackSkill: true, title: '솔라빔', vfx: 'solar' });
    effect(room, { type: 'special', vfx: 'solar', sourceId: mob.uid, targetId: target.uid, title: '솔라빔!', amount: dealt });
  });
  removeDead(room);
}

function validateTarget(player, opponent, targetId, targetType) {
  let location;
  if (targetType === 'ally') location = player.board.find((mob) => mob.uid === targetId) && { player, mob: player.board.find((mob) => mob.uid === targetId) };
  if (targetType === 'enemy') location = opponent.board.find((mob) => mob.uid === targetId) && { player: opponent, mob: opponent.board.find((mob) => mob.uid === targetId) };
  if (targetType === 'any') {
    const mob = player.board.find((entry) => entry.uid === targetId);
    location = mob ? { player, mob } : null;
    if (!location) {
      const enemyMob = opponent.board.find((entry) => entry.uid === targetId);
      location = enemyMob ? { player: opponent, mob: enemyMob } : null;
    }
  }
  if (!location) throw new Error('올바른 대상을 선택해 주세요.');
  return location;
}

function doDamageSkill(room, player, source, targets, base, skill) {
  const opponent = opponentOf(room, player);
  const amount = outgoingDamage(player, source, base);
  let total = 0;
  for (const target of targets) {
    total += damage(room, opponent, target, amount, { attackSkill: true, title: skill.name, vfx: cardOf(source).visual.vfx });
    if (source.stacks.fuel > 0 && target.hp > 0) {
      target.statuses.burn = true;
      effect(room, { type: 'status', vfx: 'fire', targetId: target.uid, title: '화상 부여' });
    }
  }
  consumeNextAttackModifiers(source);
  if (source.cardId === 'awakened') heal(room, source, Math.floor(total * 0.3), '연기력');
  return total;
}

function resolveSkill(room, player, source, skill, targetId) {
  const opponent = opponentOf(room, player);
  const definition = cardOf(source);
  if (source.skillUsed) throw new Error('이 몹은 이번 턴에 이미 스킬을 사용했습니다.');
  if (source.solarTurns > 0) throw new Error('솔라빔을 준비 중이라 스킬을 사용할 수 없습니다.');
  if (skill.effect === 'passive') throw new Error('패시브 스킬은 직접 사용할 수 없습니다.');
  if (source.statuses.sleep) {
    source.statuses.sleep = 0;
    source.skillUsed = true;
    effect(room, { type: 'status', vfx: 'sleep', targetId: source.uid, title: '잠듦', text: '공격이 취소되었습니다.' });
    log(room, `${definition.name}은(는) 잠들어 스킬을 사용하지 못했습니다.`, 'status');
    return;
  }
  if (source.statuses.confusion) {
    const heads = coin(room, `${definition.name}의 혼란 판정`);
    if (!heads) {
      source.skillUsed = true;
      damage(room, player, source, 20, { title: '혼란', vfx: 'confuse', noRedirect: true });
      log(room, `${definition.name}의 혼란으로 스킬이 취소되었습니다.`, 'status');
      removeDead(room);
      return;
    }
    source.statuses.confusion = false;
  }

  const requiresEnemy = skill.target === 'enemy';
  let target = null;
  if (requiresEnemy) {
    target = validateTarget(player, opponent, targetId, 'enemy').mob;
    const forced = opponent.board.find((mob) => mob.modifiers.forceTarget);
    if (forced && forced.uid !== target.uid) throw new Error('강제 대상으로 지정된 몹을 먼저 공격해야 합니다.');
  }

  source.skillUsed = true;
  effect(room, { type: 'skill', vfx: definition.visual.vfx, sourceId: source.uid, targetId: target?.uid, title: skill.name });
  log(room, `${player.name}의 ${definition.name}: ${skill.name}`, 'skill');

  switch (skill.effect) {
    case 'damage':
      doDamageSkill(room, player, source, [target], skill.amount, skill);
      break;
    case 'damage-all':
      doDamageSkill(room, player, source, [...opponent.board], skill.amount, skill);
      break;
    case 'heal':
      heal(room, source, skill.amount, skill.name);
      break;
    case 'sleep':
      target.statuses.sleep = 1;
      effect(room, { type: 'status', vfx: 'sleep', targetId: target.uid, title: '잠듦 부여' });
      break;
    case 'overcharge':
      addOvercharge(room, player, source, skill.amount, skill.name);
      break;
    case 'discharge':
      doDamageSkill(room, player, source, [target], skill.amount + source.stacks.overcharge * 40, skill);
      break;
    case 'coin-confuse':
      if (coin(room, skill.name)) {
        target.statuses.confusion = true;
        effect(room, { type: 'status', vfx: 'confuse', targetId: target.uid, title: '혼란 부여' });
      }
      break;
    case 'set-electric-field':
      player.fieldEffect = 'electric-field';
      effect(room, { type: 'field', vfx: 'electric', title: '전기장 설치', sourceId: source.uid });
      break;
    case 'million-volts': {
      const totalStacks = player.board.reduce((sum, mob) => sum + mob.stacks.overcharge, 0);
      const bonus = totalStacks * 20 * (player.fieldEffect === 'electric-field' ? 2 : 1);
      doDamageSkill(room, player, source, [target], skill.amount + bonus, skill);
      break;
    }
    case 'start-engine':
      doDamageSkill(room, player, source, [target], skill.amount, skill);
      source.modifiers.damageBonus += 40;
      heal(room, source, Math.min(150, source.stacks.fuel * 15), '시동 걸기');
      break;
    case 'go-wild':
      doDamageSkill(room, player, source, [target], skill.amount + source.stacks.fuel * 20, skill);
      break;
    case 'roar':
      doDamageSkill(room, player, source, [target], skill.amount, skill);
      target.modifiers.nextAttackHalf = true;
      effect(room, { type: 'status', vfx: 'roar', targetId: target.uid, title: '다음 공격 약화' });
      break;
    case 'solar-prep':
      source.solarTurns = 2;
      effect(room, { type: 'status', vfx: 'solar', targetId: source.uid, title: '솔라빔 준비', text: '2턴 뒤 자동 발사' });
      break;
    case 'running-damage': {
      const same = source.lastSkill === skill.id;
      doDamageSkill(room, player, source, [target], skill.amount + (same ? 60 : 0), skill);
      break;
    }
    case 'running-heal': {
      const same = source.lastSkill === skill.id;
      heal(room, source, skill.amount + (same ? 40 : 0), skill.name);
      break;
    }
    case 'round-kick':
      doDamageSkill(room, player, source, [target], skill.amount, skill);
      if (!coin(room, skill.name)) {
        source.statuses.confusion = true;
        effect(room, { type: 'status', vfx: 'confuse', targetId: source.uid, title: '혼란 부여' });
      }
      break;
    case 'pretend-close': {
      const sameTarget = source.lastTargetId === target.uid;
      const dealt = doDamageSkill(room, player, source, [target], skill.amount, skill);
      if (sameTarget) heal(room, source, Math.floor(dealt * 0.3), '아침 시간 자습');
      target.modifiers.nextAttackWeak = true;
      effect(room, { type: 'status', vfx: 'heart', targetId: target.uid, title: '다음 공격 약화' });
      break;
    }
    case 'run-away': {
      const all = room.players.flatMap((entry) => entry.board.map((mob) => ({ owner: entry, mob })));
      all.forEach(({ owner, mob }) => damage(room, owner, mob, skill.amount, { title: skill.name, vfx: 'disaster', noRedirect: true }));
      room.healingForbidden = true;
      room.healingSourceUid = source.uid;
      effect(room, { type: 'special', vfx: 'disaster', sourceId: source.uid, title: '재해 발생!', text: '다른 모든 카드가 회복할 수 없습니다.' });
      break;
    }
    default:
      throw new Error('아직 처리되지 않은 스킬입니다.');
  }
  source.lastSkill = skill.id;
  if (target) source.lastTargetId = target.uid;
  removeDead(room);
}

function playCard(room, player, cardUid, targetId) {
  const index = player.hand.findIndex((card) => card.uid === cardUid);
  if (index === -1) throw new Error('패에 없는 카드입니다.');
  const instance = player.hand[index];
  const definition = cardOf(instance);
  const opponent = opponentOf(room, player);

  if (definition.id === 'gyarados') {
    if (!targetId) throw new Error('갸라도스는 빈 필드에 낼 수 없습니다. 필드의 인면어 전장연 위에 놓아 진화시켜야 합니다.');
    const targetMob = player.board.find((entry) => entry.uid === targetId);
    if (!targetMob || targetMob.cardId !== 'face-fish') {
      throw new Error('갸라도스는 아군 인면어 전장연 위에만 진화시킬 수 있습니다.');
    }
    if (targetMob.placedTurn !== null && targetMob.placedTurn !== undefined && targetMob.placedTurn === room.turnNumber) {
      throw new Error('인면어 전장연을 배치한 턴에는 바로 진화할 수 없습니다.');
    }
    const hpRatio = targetMob.hp / Math.max(targetMob.maxHp, 1);
    targetMob.cardId = 'gyarados';
    targetMob.maxHp = cards.get('gyarados').hp;
    targetMob.hp = Math.max(1, Math.ceil(targetMob.maxHp * hpRatio));
    player.hand.splice(index, 1);
    player.trash.push({ uid: instance.uid, cardId: 'gyarados' });
    effect(room, {
      type: 'special',
      vfx: 'tidal',
      targetId: targetMob.uid,
      playerSeat: player.seat,
      playerName: player.name,
      cardName: definition.name,
      title: `${player.name} 님이 갸라도스로 진화!`,
      text: '인면어 전장연이 갸라도스 전장연으로 진화했습니다.'
    });
    log(room, `${player.name} 님이 인면어 전장연을 갸라도스 전장연으로 진화시켰습니다!`, 'special');
    return;
  }

  if (definition.type === 'mob') {
    if (player.board.length >= RULES.maxBoardSize) throw new Error(`필드에는 몹을 최대 ${RULES.maxBoardSize}장까지 놓을 수 있습니다.`);
    instance.placedTurn = room.turnNumber;
    player.hand.splice(index, 1);
    player.board.push(instance);
    effect(room, {
      type: 'play-mob',
      vfx: definition.visual.vfx,
      targetId: instance.uid,
      playerSeat: player.seat,
      playerName: player.name,
      cardName: definition.name,
      title: `${player.name} 님이 [${definition.name}] 배치!`,
      text: `HP ${instance.hp}`
    });
    log(room, `${player.name} 님이 ${definition.name}을(를) 필드에 냈습니다.`, 'play');
    if (definition.id === 'nature-disaster') {
      effect(room, { type: 'special', vfx: 'disaster', targetId: instance.uid, title: '자연재해?? 등장!', text: '전장이 흔들립니다.' });
    }
    return;
  }

  if (definition.type === 'attachment') {
    const { mob } = validateTarget(player, opponent, targetId, 'ally');
    player.hand.splice(index, 1);
    mob.attachments.push(definition.id);
    player.trash.push({ uid: instance.uid, cardId: instance.cardId, attached: true });
    effect(room, {
      type: 'attach',
      vfx: definition.visual.vfx,
      targetId: mob.uid,
      playerSeat: player.seat,
      playerName: player.name,
      cardName: definition.name,
      title: `${player.name} 님이 [${definition.name}] 부착!`,
      text: `${cardOf(mob).name}에 부착되었습니다.`
    });
    log(room, `${definition.name}이(가) ${cardOf(mob).name}에 부착되었습니다.`, 'play');
    maybeAwaken(room, player, mob);
    return;
  }

  const targetRules = {
    'remove-attachments': 'enemy',
    cleanse: 'ally',
    'positive-negative': 'any',
    'return-to-hand': 'ally',
    'force-target': 'ally',
    hyperfocus: 'ally'
  };
  const targetRule = targetRules[definition.effect];
  let selection = null;
  if (targetRule) selection = validateTarget(player, opponent, targetId, targetRule);
  player.hand.splice(index, 1);
  player.trash.push({ uid: instance.uid, cardId: instance.cardId });
  effect(room, {
    type: 'item',
    vfx: definition.visual.vfx,
    targetId: selection?.mob?.uid,
    playerSeat: player.seat,
    playerName: player.name,
    cardName: definition.name,
    title: `${player.name} 님이 [${definition.name}] 사용!`,
    text: definition.text
  });
  log(room, `${player.name} 님이 ${definition.name}을(를) 사용했습니다.`, 'play');

  switch (definition.effect) {
    case 'draw-random-mob': {
      const drawn = drawCard(room, player, true);
      log(room, drawn ? `${player.name} 님이 몹 카드 1장을 드로우했습니다.` : '드로우할 몹 카드가 없습니다.', 'draw');
      break;
    }
    case 'draw-two':
      drawCard(room, player);
      drawCard(room, player);
      log(room, `${player.name} 님이 카드 2장을 드로우했습니다.`, 'draw');
      break;
    case 'remove-attachments': {
      const removed = [...selection.mob.attachments];
      selection.mob.attachments = [];
      removed.forEach((cardId) => selection.player.trash.push(createCard(cardId)));
      effect(room, { type: 'shatter', vfx: 'shatter', targetId: selection.mob.uid, title: `부착 아이템 ${removed.length}개 제거` });
      break;
    }
    case 'cleanse':
      selection.mob.statuses = { confusion: false, burn: false, sleep: 0 };
      effect(room, { type: 'cleanse', vfx: 'cleanse', targetId: selection.mob.uid, title: '상태 이상 해제' });
      break;
    case 'positive-negative':
      if (coin(room, 'positive negative')) heal(room, selection.mob, 100, 'positive');
      else damage(room, selection.player, selection.mob, 100, { title: 'negative', vfx: 'coin' });
      break;
    case 'return-to-hand': {
      const target = selection.mob;
      selection.player.board = selection.player.board.filter((mob) => mob.uid !== target.uid);
      target.attachments.forEach((cardId) => selection.player.trash.push(createCard(cardId)));
      selection.player.hand.push(createCard(target.cardId));
      effect(room, { type: 'return', vfx: 'return', targetId: target.uid, title: '패로 되돌림' });
      break;
    }
    case 'force-target':
      selection.mob.modifiers.forceTarget = true;
      break;
    case 'hyperfocus':
      selection.mob.modifiers.nextDamageMultiplier = 0.5;
      break;
    case 'confuse-all':
      opponent.board.forEach((mob) => { mob.statuses.confusion = true; });
      effect(room, { type: 'status', vfx: 'confuse', title: '기습 수행평가!', text: '상대 전체가 혼란에 빠졌습니다.' });
      break;
    case 'nothing':
      effect(room, { type: 'shrug', vfx: 'shrug', title: '아헤장연', text: '아무 일도 일어나지 않았습니다.' });
      break;
    default:
      throw new Error('아직 처리되지 않은 아이템입니다.');
  }
  removeDead(room);
}

function devour(room, player, sourceUid, targetId) {
  const source = player.board.find((mob) => mob.uid === sourceUid);
  const target = player.board.find((mob) => mob.uid === targetId);
  if (!source || source.cardId !== 'nature-disaster') throw new Error('자연재해??만 포식할 수 있습니다.');
  if (!target || target.uid === source.uid) throw new Error('다른 아군 몹을 선택해 주세요.');
  player.board = player.board.filter((mob) => mob.uid !== target.uid);
  trashMob(player, target);
  heal(room, source, 100, '포식');
  effect(room, { type: 'special', vfx: 'disaster', sourceId: source.uid, targetId: target.uid, title: '포식!', text: `${cardOf(target).name}을 포식했습니다.` });
  log(room, `${cardOf(source).name}이(가) ${cardOf(target).name}을 포식했습니다.`, 'special');
  checkVictory(room);
}

function performAction(socket, payload) {
  const found = playerForSocket(socket);
  if (!found) throw new Error('방에 다시 입장해 주세요.');
  const { room, player } = found;
  const action = payload || {};

  // 1. 시작 몹 배치 단계 (setup)
  if (room.status === 'setup') {
    if (action.type !== 'play') throw new Error('시작 몹을 필드에 배치해 주세요.');
    if (player.board.length >= 1) throw new Error('이미 시작 몹을 배치했습니다. 상대방을 기다리는 중입니다.');

    const cardInstance = player.hand.find((card) => card.uid === action.cardUid);
    if (!cardInstance) throw new Error('패에 없는 카드입니다.');
    const definition = cardOf(cardInstance);
    if (definition.type !== 'mob' || definition.id === 'nature-disaster' || definition.id === 'gyarados') {
      throw new Error('시작 몹은 일반 몹 카드만 배치할 수 있습니다. (갸라도스/자연재해 제외)');
    }

    cardInstance.placedTurn = 0;
    playCard(room, player, action.cardUid, action.targetId);
    if (player.board[0]) player.board[0].placedTurn = 0;

    const allPlaced = room.players.every((p) => p.board.length >= 1);
    if (allPlaced) {
      startCoinFlipAndGame(room);
    } else {
      log(room, `${player.name} 님이 시작 몹을 배치했습니다. 상대방을 기다리는 중...`, 'system');
      emitState(room);
    }
    return;
  }

  // 2. 대전 진행 단계 (playing)
  if (room.status !== 'playing') throw new Error('진행 중인 게임이 아닙니다.');
  if (room.activeSeat !== player.seat) throw new Error('상대의 턴입니다.');

  switch (action.type) {
    case 'draw': {
      if (player.drawUsed) throw new Error('드로우는 턴에 한 번만 할 수 있습니다.');
      const drawn = drawCard(room, player);
      if (!drawn) throw new Error('덱에 카드가 없습니다.');
      player.drawUsed = true;
      effect(room, { type: 'draw', vfx: 'draw', playerSeat: player.seat, playerName: player.name, title: `${player.name} 드로우` });
      log(room, `${player.name} 님이 카드 1장을 드로우했습니다.`, 'draw');
      break;
    }
    case 'play':
      playCard(room, player, action.cardUid, action.targetId);
      break;
    case 'skill': {
      const source = player.board.find((mob) => mob.uid === action.sourceUid);
      if (!source) throw new Error('필드에 없는 몹입니다.');
      const skill = cardOf(source).skills.find((entry) => entry.id === action.skillId);
      if (!skill) throw new Error('알 수 없는 스킬입니다.');
      resolveSkill(room, player, source, skill, action.targetId);

      // 스킬 사용 후 자동으로 턴 종료!
      if (room.status === 'playing' && room.winner === null) {
        room.activeSeat = player.seat === 0 ? 1 : 0;
        room.turnNumber += 1;
        beginTurn(room, playerBySeat(room, room.activeSeat));
      }
      break;
    }
    case 'evolve': {
      const source = player.board.find((mob) => mob.uid === action.sourceUid);
      if (!source) throw new Error('필드에 없는 몹입니다.');
      evolveFaceFish(room, player, source);
      break;
    }
    case 'devour':
      devour(room, player, action.sourceUid, action.targetId);
      break;
    case 'endTurn': {
      room.activeSeat = player.seat === 0 ? 1 : 0;
      room.turnNumber += 1;
      beginTurn(room, playerBySeat(room, room.activeSeat));
      break;
    }
    default:
      throw new Error('알 수 없는 행동입니다.');
  }
  emitState(room);
}

function joinSocketToRoom(socket, room, player) {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  player.socketId = socket.id;
  player.connected = true;
}

function removeFromQueue(socketId) {
  const index = matchmakingQueue.findIndex((entry) => entry.socket.id === socketId);
  if (index !== -1) {
    matchmakingQueue.splice(index, 1);
    return true;
  }
  return false;
}

function tryMatchmaking() {
  while (matchmakingQueue.length >= 2) {
    const entry1 = matchmakingQueue.shift();
    const entry2 = matchmakingQueue.shift();

    if (!entry1.socket.connected) {
      if (entry2.socket.connected) matchmakingQueue.unshift(entry2);
      continue;
    }
    if (!entry2.socket.connected) {
      matchmakingQueue.unshift(entry1);
      continue;
    }

    const code = makeRoomCode();
    const player1 = newPlayer({
      id: entry1.playerId,
      name: entry1.name,
      socketId: entry1.socket.id,
      seat: 0,
      customDeck: entry1.customDeck
    });
    const player2 = newPlayer({
      id: entry2.playerId,
      name: entry2.name,
      socketId: entry2.socket.id,
      seat: 1,
      customDeck: entry2.customDeck
    });

    const room = {
      code,
      players: [player1, player2],
      status: 'lobby',
      activeSeat: 0,
      turnNumber: 0,
      logs: [],
      winner: null
    };
    rooms.set(code, room);

    joinSocketToRoom(entry1.socket, room, player1);
    joinSocketToRoom(entry2.socket, room, player2);

    log(room, `${player1.name} 님과 ${player2.name} 님이 매칭되었습니다!`, 'system');

    entry1.socket.emit('matchFound', { ok: true, code, playerId: player1.id });
    entry2.socket.emit('matchFound', { ok: true, code, playerId: player2.id });

    startGame(room);
    emitState(room);
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', (data, callback = () => {}) => {
    try {
      removeFromQueue(socket.id);
      const name = cleanName(data?.name);
      const playerId = typeof data?.playerId === 'string' && data.playerId.length >= 8 ? data.playerId : makeId('p');
      const code = makeRoomCode();
      const player = newPlayer({
        id: playerId,
        name,
        socketId: socket.id,
        seat: 0,
        customDeck: data?.customDeck
      });
      const room = { code, players: [player], status: 'lobby', activeSeat: 0, turnNumber: 0, logs: [], winner: null };
      rooms.set(code, room);
      joinSocketToRoom(socket, room, player);
      log(room, `${name} 님이 방을 만들었습니다.`, 'system');
      callback({ ok: true, code, playerId });
      emitState(room);
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on('joinRoom', (data, callback = () => {}) => {
    try {
      removeFromQueue(socket.id);
      const code = String(data?.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) throw new Error('존재하지 않거나 만료된 방 코드입니다.');
      const playerId = typeof data?.playerId === 'string' ? data.playerId : '';
      let player = room.players.find((entry) => entry.id === playerId);
      if (player) {
        if (Array.isArray(data?.customDeck)) player.customDeck = data.customDeck;
        joinSocketToRoom(socket, room, player);
        log(room, `${player.name} 님이 다시 연결되었습니다.`, 'system');
      } else {
        if (room.status !== 'lobby' || room.players.length >= 2) throw new Error('이 방은 이미 가득 찼습니다.');
        const name = cleanName(data?.name);
        player = newPlayer({
          id: playerId.length >= 8 ? playerId : makeId('p'),
          name,
          socketId: socket.id,
          seat: room.players.length,
          customDeck: data?.customDeck
        });
        room.players.push(player);
        joinSocketToRoom(socket, room, player);
        log(room, `${name} 님이 방에 입장했습니다.`, 'system');
      }
      callback({ ok: true, code, playerId: player.id });
      if (room.status === 'lobby' && room.players.length === 2) startGame(room);
      emitState(room);
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on('startMatchmaking', (data, callback = () => {}) => {
    try {
      const name = cleanName(data?.name);
      const playerId = typeof data?.playerId === 'string' && data.playerId.length >= 8 ? data.playerId : makeId('p');
      removeFromQueue(socket.id);
      matchmakingQueue.push({
        socket,
        playerId,
        name,
        customDeck: data?.customDeck
      });
      callback({ ok: true, message: '상대를 찾는 중입니다...' });
      tryMatchmaking();
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on('cancelMatchmaking', (_data, callback = () => {}) => {
    removeFromQueue(socket.id);
    callback({ ok: true });
  });

  socket.on('gameAction', (payload, callback = () => {}) => {
    try {
      performAction(socket, payload);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, message: error.message });
    }
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    const found = playerForSocket(socket);
    if (!found) return;
    const { room, player } = found;
    if (player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    log(room, `${player.name} 님의 연결이 끊겼습니다.`, 'system');
    emitState(room);
  });
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`고아 카드 게임 서버가 ${port}번 포트에서 실행 중입니다.`);
});
