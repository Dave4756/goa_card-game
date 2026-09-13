(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const lobbyScreen = $('#lobby-screen');
  const gameScreen = $('#game-screen');
  const nameInput = $('#name-input');
  const roomInput = $('#room-input');
  const lobbyMessage = $('#lobby-message');
  const modal = $('#modal');
  const modalContent = $('#modal-content');
  const playDialog = $('#play-dialog');
  const deckDialog = $('#deck-dialog');
  const matchmakingArea = $('#matchmaking-active-area');
  const startMatchmakingBtn = $('#start-matchmaking-button');
  const cancelMatchmakingBtn = $('#cancel-matchmaking-button');
  const toast = $('#toast');
  const effectLayer = $('#effect-layer');

  const accents = {
    gold: '#d9a646', cyan: '#4dd5dc', blue: '#4b86ff', violet: '#a377e8', steel: '#9aacb9',
    rose: '#ef7c9c', yellow: '#f1cd36', orange: '#ed8841', green: '#62b976', lime: '#b6d844',
    silver: '#c4d0dd', prism: '#d9a9ff', crimson: '#e65758', coral: '#ef886f', teal: '#43c2b0',
    pink: '#e989c6', brown: '#b98358', red: '#ed6969', white: '#e4f0f0', gray: '#91a0a2',
    indigo: '#7e84ea', purple: '#b279e9', black: '#525b64'
  };

  const DEFAULT_DECK = [
    'jeonjangyeon', 'face-fish', 'gyarados', 'snorlax', 'mecha', 'jongchu', 'biker',
    'patience', 'patience', 'learning', 'sociability', 'sociability',
    'draw-one-mob', 'draw-one-mob', 'cleanse', 'cleanse', 'bag', 'bag', 'positive-negative', 'eraser'
  ];

  let definitions = new Map();
  let state = null;
  let selected = null;
  let pending = null;
  let playerId = sessionStorage.getItem('goa-player-id');
  if (!playerId) {
    playerId = makePlayerId();
    sessionStorage.setItem('goa-player-id', playerId);
  }
  let currentCustomDeck = [];
  let isMatchmaking = false;
  let socket;
  let reconnecting = false;
  let effectQueue = [];
  let showingEffect = false;
  let toastTimer;

  sessionStorage.setItem('goa-player-id', playerId);
  nameInput.value = localStorage.getItem('goa-player-name') || '';
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) roomInput.value = urlRoom.toUpperCase().slice(0, 5);

  function makePlayerId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `player-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
    }[character]));
  }

  function definition(cardId) {
    return definitions.get(cardId);
  }

  function cardColor(card) {
    return accents[card?.visual?.accent] || '#a5c9c4';
  }

  function cardImageUrl(img) {
    if (!img) return '';
    if (img.startsWith('http://') || img.startsWith('https://') || img.startsWith('/')) return img;
    return `/image/${img}`;
  }

  function loadSavedDeck() {
    try {
      const raw = localStorage.getItem('goa-player-deck');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length >= 10) {
          const counts = new Map();
          const cleaned = [];
          for (const id of parsed) {
            const cnt = counts.get(id) || 0;
            const maxAllowed = id === 'nature-disaster' ? 1 : 2;
            if (cnt < maxAllowed && cleaned.length < 20) {
              counts.set(id, cnt + 1);
              cleaned.push(id);
            }
          }
          if (cleaned.length >= 10) {
            currentCustomDeck = cleaned;
            saveDeckToStorage();
            updateDeckBadge();
            return;
          }
        }
      }
    } catch (_e) {}
    currentCustomDeck = [...DEFAULT_DECK];
    saveDeckToStorage();
    updateDeckBadge();
  }

  function saveDeckToStorage() {
    localStorage.setItem('goa-player-deck', JSON.stringify(currentCustomDeck));
    updateDeckBadge();
  }

  function updateDeckBadge() {
    const badge = $('#deck-status-badge');
    if (badge) badge.textContent = `${currentCustomDeck.length}장 구성됨`;
  }

  function showToast(message, kind = '') {
    toast.textContent = message;
    toast.className = `toast visible ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2800);
  }

  function setLobbyMessage(message, error = false) {
    lobbyMessage.textContent = message;
    lobbyMessage.classList.toggle('error', error);
  }

  function setConnection(label, connected) {
    const el = $('#connection-state');
    el.innerHTML = `<i></i> ${escapeHtml(label)}`;
    el.classList.toggle('offline', !connected);
  }

  async function loadDefinitions() {
    try {
      const response = await fetch('/data/cards.json');
      if (!response.ok) throw new Error('카드 데이터를 불러오지 못했습니다.');
      const payload = await response.json();
      definitions = new Map(payload.cards.map((card) => [card.id, card]));
      loadSavedDeck();
    } catch (error) {
      setLobbyMessage(error.message, true);
    }
  }

  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      setConnection('실시간 연결됨', true);
      if (reconnecting && activeRoomCode) {
        socket.emit('joinRoom', {
          code: activeRoomCode,
          name: localStorage.getItem('goa-player-name'),
          playerId,
          customDeck: currentCustomDeck
        }, (reply) => {
          if (!reply?.ok) showToast(reply?.message || '방 재연결에 실패했습니다.', 'error');
        });
      }
      reconnecting = true;
    });
    socket.on('disconnect', () => setConnection('연결 재시도 중', false));
    socket.on('gameState', (nextState) => {
      state = nextState;
      activeRoomCode = nextState.roomCode;
      localStorage.setItem('goa-room-code', activeRoomCode);
      if (playDialog.close) playDialog.close();
      if (deckDialog.close) deckDialog.close();
      showGame();
      render();
    });
    socket.on('matchFound', (_data) => {
      isMatchmaking = false;
      if (matchmakingArea) matchmakingArea.classList.add('hidden');
      if (startMatchmakingBtn) startMatchmakingBtn.classList.remove('hidden');
      if (playDialog.close) playDialog.close();
      showToast('상대를 찾았습니다! 대전을 시작합니다.');
    });
    socket.on('gameEffect', (event) => enqueueEffect(event));
  }

  function showGame() {
    lobbyScreen.classList.add('hidden');
    gameScreen.classList.remove('hidden');
  }

  function send(event, payload) {
    return new Promise((resolve) => {
      if (!socket?.connected) {
        showToast('서버 연결을 기다리는 중입니다.', 'error');
        resolve({ ok: false });
        return;
      }
      socket.emit(event, payload, (reply) => {
        if (!reply?.ok) showToast(reply?.message || '처리할 수 없는 행동입니다.', 'error');
        resolve(reply || { ok: false });
      });
    });
  }

  function cleanName() {
    const value = nameInput.value.trim().replace(/\s+/g, ' ');
    if (value.length < 2 || value.length > 16) {
      setLobbyMessage('닉네임은 2~16자로 입력해 주세요.', true);
      return null;
    }
    localStorage.setItem('goa-player-name', value);
    return value;
  }

  function openPlayModal() {
    const name = cleanName();
    if (!name) return;
    if (playDialog?.showModal) playDialog.showModal();
    else if (playDialog) playDialog.setAttribute('open', '');
  }

  function closePlayModal() {
    cancelMatchmaking();
    if (playDialog?.close) playDialog.close();
    else if (playDialog) playDialog.removeAttribute('open');
  }

  function openDeckBuilder() {
    renderDeckBuilder();
    if (deckDialog?.showModal) deckDialog.showModal();
    else if (deckDialog) deckDialog.setAttribute('open', '');
  }

  function closeDeckBuilder() {
    if (deckDialog?.close) deckDialog.close();
    else if (deckDialog) deckDialog.removeAttribute('open');
  }

  function renderDeckBuilder() {
    const currentGrid = $('#current-deck-grid');
    const catalogGrid = $('#catalog-card-grid');
    const countIndicator = $('#deck-count-indicator');
    const currentCount = $('#deck-current-count');

    if (countIndicator) countIndicator.innerHTML = `총 <b>${currentCustomDeck.length}</b>장 (10~20장, 같은 카드 최대 2장)`;
    if (currentCount) currentCount.textContent = currentCustomDeck.length;

    const counts = new Map();
    currentCustomDeck.forEach((id) => {
      counts.set(id, (counts.get(id) || 0) + 1);
    });

    let currentHtml = '';
    const sortedIds = Array.from(counts.keys()).sort((a, b) => {
      const cardA = definition(a);
      const cardB = definition(b);
      const order = { mob: 1, attachment: 2, consumable: 3 };
      return (order[cardA?.type] || 4) - (order[cardB?.type] || 4);
    });

    sortedIds.forEach((id) => {
      const card = definition(id);
      if (!card) return;
      const count = counts.get(id);
      const thumb = card.image
        ? `<img src="${cardImageUrl(card.image)}" alt="${escapeHtml(card.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='';" /><span style="display:none;">${escapeHtml(card.visual?.icon || '◆')}</span>`
        : `<span>${escapeHtml(card.visual?.icon || '◆')}</span>`;
      const typeLabel = card.type === 'mob' ? '몹' : card.type === 'attachment' ? '부착' : '소모';

      currentHtml += `
        <div class="builder-card" data-remove-card="${escapeHtml(id)}" title="클릭하여 1장 제거">
          <span class="card-count-badge">×${count}</span>
          <div class="builder-card-thumb" style="color:${cardColor(card)}">${thumb}</div>
          <div class="builder-card-name">${escapeHtml(card.name)}</div>
          <div class="builder-card-type"><span>${typeLabel}</span><small style="color:#ef8278">제거 -</small></div>
        </div>
      `;
    });

    if (currentGrid) {
      currentGrid.innerHTML = currentHtml || '<p style="grid-column: 1/-1; color:#8ea09b; padding:1.5rem; text-align:center;">덱에 카드가 없습니다. 아래 도감에서 카드를 클릭해 추가하세요.</p>';
    }

    let catalogHtml = '';
    definitions.forEach((card) => {
      if (card.hidden) return;
      const thumb = card.image
        ? `<img src="${cardImageUrl(card.image)}" alt="${escapeHtml(card.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='';" /><span style="display:none;">${escapeHtml(card.visual?.icon || '◆')}</span>`
        : `<span>${escapeHtml(card.visual?.icon || '◆')}</span>`;
      const typeLabel = card.type === 'mob' ? '몹' : card.type === 'attachment' ? '부착' : '소모';
      const inDeckCount = counts.get(card.id) || 0;
      const maxLimit = card.id === 'nature-disaster' ? 1 : 2;
      const isMax = inDeckCount >= maxLimit;

      catalogHtml += `
        <div class="builder-card" data-add-card="${escapeHtml(card.id)}" title="${isMax ? '최대 매수 도달' : '클릭하여 덱에 1장 추가'}">
          ${inDeckCount > 0 ? `<span class="card-count-badge" style="background:${isMax ? '#ef7975' : '#5ed4c0'}; color:#062327;">보유 ${inDeckCount}/${maxLimit}</span>` : ''}
          <div class="builder-card-thumb" style="color:${cardColor(card)}">${thumb}</div>
          <div class="builder-card-name">${escapeHtml(card.name)}</div>
          <div class="builder-card-type"><span>${typeLabel}</span><small style="color:${isMax ? '#ef7975' : '#64dfc8'}">${isMax ? '최대' : '추가 +'}</small></div>
        </div>
      `;
    });

    if (catalogGrid) {
      catalogGrid.innerHTML = catalogHtml;
    }
  }

  function addCardToDeck(cardId) {
    const maxLimit = cardId === 'nature-disaster' ? 1 : 2;
    const currentCount = currentCustomDeck.filter((id) => id === cardId).length;
    if (currentCount >= maxLimit) {
      showToast(cardId === 'nature-disaster'
        ? '자연재해?? 카드는 덱에 최대 1장만 포함할 수 있습니다.'
        : '같은 카드는 덱에 최대 2장까지만 포함할 수 있습니다.', 'error');
      return;
    }
    if (currentCustomDeck.length >= 20) {
      showToast('덱은 최대 20장까지 구성할 수 있습니다.', 'error');
      return;
    }
    currentCustomDeck.push(cardId);
    saveDeckToStorage();
    renderDeckBuilder();
  }

  function removeCardFromDeck(cardId) {
    const idx = currentCustomDeck.lastIndexOf(cardId);
    if (idx !== -1) {
      currentCustomDeck.splice(idx, 1);
      saveDeckToStorage();
      renderDeckBuilder();
    }
  }

  function startMatchmaking() {
    const name = cleanName();
    if (!name) return;
    if (currentCustomDeck.length < 10 || currentCustomDeck.length > 20) {
      showToast('덱 편성은 10장 이상 20장 이하이어야 합니다.', 'error');
      return;
    }
    const hasMob = currentCustomDeck.some((id) => {
      const def = definition(id);
      return def?.type === 'mob' && id !== 'nature-disaster' && id !== 'gyarados';
    });
    if (!hasMob) {
      showToast('덱에 시작 몹 카드가 최소 1장 이상 있어야 합니다. (갸라도스/자연재해 제외)', 'error');
      return;
    }

    isMatchmaking = true;
    if (startMatchmakingBtn) startMatchmakingBtn.classList.add('hidden');
    if (matchmakingArea) matchmakingArea.classList.remove('hidden');

    socket.emit('startMatchmaking', {
      name,
      playerId,
      customDeck: currentCustomDeck
    }, (reply) => {
      if (!reply?.ok) {
        showToast(reply?.message || '매치메이킹 등록에 실패했습니다.', 'error');
        cancelMatchmaking();
      }
    });
  }

  function cancelMatchmaking() {
    if (!isMatchmaking) return;
    isMatchmaking = false;
    socket.emit('cancelMatchmaking');
    if (matchmakingArea) matchmakingArea.classList.add('hidden');
    if (startMatchmakingBtn) startMatchmakingBtn.classList.remove('hidden');
  }

  async function createRoom() {
    const name = cleanName();
    if (!name) return;
    const reply = await send('createRoom', { name, playerId, customDeck: currentCustomDeck });
    if (!reply.ok) {
      setLobbyMessage(reply.message || '방을 만들 수 없습니다.', true);
      return;
    }
    closePlayModal();
    activeRoomCode = reply.code;
    updateRoomUrl(reply.code);
    setLobbyMessage(`방 ${reply.code}를 만들었습니다. 친구를 기다리는 중입니다.`);
  }

  async function joinRoom() {
    const name = cleanName();
    if (!name) return;
    const code = roomInput.value.trim().toUpperCase();
    if (code.length !== 5) {
      setLobbyMessage('5자리 방 코드를 입력해 주세요.', true);
      return;
    }
    const reply = await send('joinRoom', { code, name, playerId, customDeck: currentCustomDeck });
    if (!reply.ok) {
      setLobbyMessage(reply.message || '방에 입장할 수 없습니다.', true);
      return;
    }
    closePlayModal();
    playerId = reply.playerId;
    sessionStorage.setItem('goa-player-id', playerId);
    activeRoomCode = reply.code;
    updateRoomUrl(reply.code);
  }

  function updateRoomUrl(code) {
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState({}, '', url);
  }

  function stateCard(uid) {
    if (!state) return null;
    const hand = state.me.hand?.find((entry) => entry.uid === uid);
    if (hand) return { instance: hand, zone: 'hand', owner: 'me' };
    const own = state.me.board.find((entry) => entry.uid === uid);
    if (own) return { instance: own, zone: 'board', owner: 'me' };
    const enemy = state.opponent?.board.find((entry) => entry.uid === uid);
    if (enemy) return { instance: enemy, zone: 'board', owner: 'opponent' };
    return null;
  }

  function targetRequirement() {
    if (!state?.isMyTurn) return null;
    if (pending) return pending.target;
    if (selected?.zone !== 'hand') return null;
    const card = stateCard(selected.uid)?.instance;
    const cardDef = definition(card?.cardId);
    if (!cardDef) return null;
    if (cardDef.id === 'gyarados') return 'ally';
    if (cardDef.type === 'attachment') return 'ally';
    if (cardDef.type === 'consumable') return cardDef.target || null;
    return null;
  }

  function selectedHandDefinition() {
    if (selected?.zone !== 'hand') return null;
    return definition(stateCard(selected.uid)?.instance?.cardId);
  }

  function isTargetable(owner, mob) {
    const requirement = targetRequirement();
    if (!requirement) return false;
    if (selected?.zone === 'hand') {
      const card = stateCard(selected.uid)?.instance;
      if (card?.cardId === 'gyarados') {
        return owner === 'me' && mob.cardId === 'face-fish';
      }
    }
    if (requirement === 'any') return true;
    return (requirement === 'ally' && owner === 'me') || (requirement === 'enemy' && owner === 'opponent');
  }

  function cardStatusMarkup(mob) {
    const badges = [];
    if (mob.statuses?.confusion) badges.push('<span class="status confusion" title="혼란">혼란</span>');
    if (mob.statuses?.burn) badges.push('<span class="status burn" title="화상">화상</span>');
    if (mob.statuses?.sleep) badges.push('<span class="status sleep" title="잠듦">잠듦</span>');
    if (mob.modifiers?.forceTarget) badges.push('<span class="status focus" title="강제 대상">표적</span>');
    if (mob.solarTurns) badges.push(`<span class="status solar" title="솔라빔 준비">태양 ${mob.solarTurns}</span>`);
    return badges.join('');
  }

  function attachmentMarkup(mob) {
    if (!mob.attachments?.length) return '';
    return `<div class="attachment-row">${mob.attachments.map((id) => `<span title="${escapeHtml(definition(id)?.name || id)}">${escapeHtml(definition(id)?.visual?.icon || '◆')}</span>`).join('')}</div>`;
  }

  function stackMarkup(mob) {
    const stacks = [];
    if (mob.stacks?.overcharge) stacks.push(`<span class="stack overcharge">⚡${mob.stacks.overcharge}</span>`);
    if (mob.stacks?.fuel) stacks.push(`<span class="stack fuel">♨${mob.stacks.fuel}</span>`);
    return stacks.join('');
  }

  function mobMarkup(mob, owner, index) {
    const card = definition(mob.cardId);
    if (!card) return '';
    const selectedClass = selected?.uid === mob.uid ? 'selected' : '';
    const targetableClass = isTargetable(owner, mob) ? 'targetable' : '';
    const damaged = mob.hp / mob.maxHp < 0.35 ? 'critical' : '';
    const skills = card.skills?.filter((skill) => skill.effect !== 'passive').length || 0;
    const artContent = card.image
      ? `<img class="card-art-img" src="${cardImageUrl(card.image)}" alt="${escapeHtml(card.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='';" /><span style="display:none;">${escapeHtml(card.visual?.icon || '◆')}</span>`
      : `<span>${escapeHtml(card.visual?.icon || '◆')}</span>`;
    return `<article class="game-card mob-card ${owner} ${selectedClass} ${targetableClass} ${damaged}" data-uid="${mob.uid}" data-owner="${owner}" data-index="${index}" style="--card-accent:${cardColor(card)}" role="button" tabindex="0" aria-label="${escapeHtml(card.name)} 카드">
      <div class="card-glow"></div>
      <div class="card-top"><span class="card-type">몹</span><span class="card-icon">${escapeHtml(card.visual?.icon || '◆')}</span></div>
      <div class="card-art">${artContent}</div>
      <h3>${escapeHtml(card.name)}</h3>
      <div class="health"><span>HP</span><b>${mob.hp}</b><i>/ ${mob.maxHp}</i></div>
      <div class="health-bar"><i style="width:${Math.max(0, Math.min(100, mob.hp / mob.maxHp * 100))}%"></i></div>
      <div class="card-meta"><span>${skills} 스킬</span>${stackMarkup(mob)}</div>
      <div class="status-row">${cardStatusMarkup(mob)}</div>
      ${attachmentMarkup(mob)}
    </article>`;
  }

  function handMarkup(instance) {
    const card = definition(instance.cardId);
    if (!card) return '';
    const selectedClass = selected?.uid === instance.uid ? 'selected' : '';
    const isMob = card.type === 'mob';
    const hp = isMob ? `<div class="hand-hp">HP ${instance.hp}/${instance.maxHp}</div>` : `<p class="item-effect">${escapeHtml(card.text || '효과 카드')}</p>`;
    const artContent = card.image
      ? `<img class="card-art-img" src="${cardImageUrl(card.image)}" alt="${escapeHtml(card.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='';" /><span style="display:none;">${escapeHtml(card.visual?.icon || '◆')}</span>`
      : `<span>${escapeHtml(card.visual?.icon || '◆')}</span>`;
    return `<article class="hand-card ${card.type} ${selectedClass}" data-uid="${instance.uid}" draggable="${state?.isMyTurn ? 'true' : 'false'}" style="--card-accent:${cardColor(card)}" role="button" tabindex="0">
      <div class="hand-card-top"><span>${escapeHtml(card.type === 'mob' ? '몹' : card.type === 'attachment' ? '부착' : '소모')}</span><b>${escapeHtml(card.visual?.icon || '◆')}</b></div>
      <div class="hand-icon">${artContent}</div>
      <h3>${escapeHtml(card.name)}</h3>
      ${hp}
      ${isMob && instance.stacks ? `<div class="hand-stacks">${stackMarkup(instance)}</div>` : ''}
    </article>`;
  }

  function boardMarkup(mobs, owner) {
    const html = [];
    const isSetup = state?.status === 'setup';
    const isMyBoard = owner === 'me';
    const needStarterMob = isSetup && isMyBoard && state?.me?.board?.length === 0;
    const handDef = selectedHandDefinition();
    const canPlayToSlot = handDef?.type === 'mob' && handDef?.id !== 'gyarados';

    for (let index = 0; index < 3; index += 1) {
      const mob = mobs[index];
      const isTargetableSlot = !mob && isMyBoard && state?.isMyTurn && (canPlayToSlot || needStarterMob);
      html.push(`<div class="board-slot ${mob ? 'occupied' : 'empty'} ${isTargetableSlot ? 'targetable-slot' : ''}" data-slot="${index}" data-owner="${owner}">${mob ? mobMarkup(mob, owner, index) : `<span class="empty-slot-icon">${owner === 'me' ? '+' : '○'}</span><small>${owner === 'me' ? (needStarterMob ? '시작 몹 배치' : '필드') : '빈 필드'}</small>`}</div>`);
    }
    return html.join('');
  }

  function renderOpponentHand(count) {
    const visible = Math.min(count, 6);
    return `<div class="opponent-hand-cards">${Array.from({ length: visible }, (_, index) => `<span style="--offset:${index}">?</span>`).join('')}</div>`;
  }

  function selectionHint() {
    if (state?.status === 'setup') {
      return state.me.board.length === 0
        ? '시작 몹을 필드에 배치하세요! (손패의 몹 카드 또는 빈 필드 클릭)'
        : '상대방이 시작 몹을 배치하기를 기다리는 중입니다...';
    }
    if (state?.status === 'coin-flip') {
      return '동전을 던져 선공과 후공을 결정하는 중입니다.';
    }
    if (!state?.isMyTurn) return state?.status === 'playing' ? '상대가 행동 중입니다.' : '상대 입장을 기다리는 중입니다.';
    if (pending?.type === 'skill') return '공격할 상대 몹을 선택하세요. (스킬 발동 후 턴 종료)';
    if (pending?.type === 'devour') return '포식할 아군 몹을 선택하세요.';
    const handDef = selectedHandDefinition();
    if (handDef?.id === 'gyarados') return '필드의 아군 인면어 전장연을 선택(또는 드래그)해 진화시키세요.';
    if (handDef?.type === 'mob') return '빈 필드를 클릭하거나 카드를 드래그해 배치하세요.';
    if (handDef?.type === 'attachment') return '부착할 아군 몹을 선택하거나 드래그하세요.';
    if (handDef?.type === 'consumable') return handDef.target ? '대상을 선택하거나 카드를 대상에게 드래그하세요.' : '클릭하거나 필드에 드래그해 즉시 사용하세요.';
    return '내 몹을 클릭해 스킬을 사용하거나, 손패의 카드를 사용하세요.';
  }

  function renderInspector() {
    const inspector = $('#inspector');
    if (!inspector) return;

    if (pending?.type === 'skill') {
      inspector.innerHTML = `
        <div class="simplified-skill-box">
          <div class="simplified-skill-title">
            <span>스킬 대상 선택</span>
            <small style="color:#ef8278">선택 시 턴 종료</small>
          </div>
          <p style="color:#5ed4c0; font-size:0.92rem; margin:0.8rem 0; font-weight:700;">
            필드에서 공격할 상대 몹을 클릭하세요!
          </p>
          <button class="button cancel-skill-mode-btn" type="button" data-cancel-skill>스킬 취소</button>
        </div>
      `;
      return;
    }

    const current = selected && stateCard(selected.uid);
    if (!current) {
      inspector.innerHTML = `<div class="inspector-empty"><span class="inspect-icon">⚔</span><strong>스킬 & 행동</strong><p>내 필드의 몹을 클릭하면 즉시 스킬을 사용할 수 있습니다.</p></div>`;
      return;
    }

    const card = definition(current.instance.cardId);
    const own = current.owner === 'me';

    // 1. 필드 위의 몹 카드인 경우 (내 몹 또는 상대 몹)
    if (current.zone === 'board' && card.type === 'mob') {
      const mob = current.instance;
      const isReady = own && state.isMyTurn && !mob.skillUsed && (mob.solarTurns || 0) <= 0;
      const hpPercent = Math.max(0, Math.min(100, (mob.hp / mob.maxHp) * 100));

      const passiveHtml = card.passive
        ? `<div class="passive-box"><span>특성 · ${escapeHtml(card.passive.name)}</span><p>${escapeHtml(card.passive.text)}</p></div>`
        : '';

      const attachmentsHtml = mob.attachments?.length
        ? `<div class="detail-line"><span>부착 아이템</span><b>${mob.attachments.map(id => escapeHtml(definition(id)?.name || id)).join(', ')}</b></div>`
        : '';

      const statusDesc = statusText(mob);
      const statusLineHtml = statusDesc !== '없음'
        ? `<div class="detail-line"><span>상태 이상/스택</span><b>${escapeHtml(statusDesc)}</b></div>`
        : '';

      const skills = card.skills?.filter((skill) => skill.effect !== 'passive').map((skill) => {
        if (own) {
          const unavailable = !isReady ? 'disabled' : '';
          return `<button class="big-skill-button" type="button" data-skill="${skill.id}" data-source="${mob.uid}" ${unavailable}>
            <strong>⚡ ${escapeHtml(skill.name)}</strong>
            <small>${escapeHtml(skill.text || '')}</small>
          </button>`;
        } else {
          return `<div class="big-skill-button" style="cursor:default; opacity:0.88; background:rgba(20,40,42,0.6); border-color:rgba(120,160,155,0.25);">
            <strong>⚡ ${escapeHtml(skill.name)}</strong>
            <small>${escapeHtml(skill.text || '')}</small>
          </div>`;
        }
      }).join('') || '<p class="empty-copy">보유 스킬이 없습니다.</p>';

      let action = '';
      if (own && state.isMyTurn && card.id === 'nature-disaster') {
        action += '<button class="button special-action" type="button" data-devour style="margin-top:0.4rem; width:100%;">다른 아군 몹 포식</button>';
      }

      const ownerTag = own ? '<span style="color:#62d2bd; font-weight:800;">[아군]</span>' : '<span style="color:#f0a29b; font-weight:800;">[상대]</span>';
      const statusNotice = own
        ? (mob.skillUsed ? '이번 턴 스킬 사용 완료' : (state.isMyTurn ? '스킬 누르면 대상 선택 후 턴 종료' : '상대 턴'))
        : '상대 몹 상세 정보';

      const artContent = card.image
        ? `<img class="inspector-thumb-img" src="${cardImageUrl(card.image)}" alt="${escapeHtml(card.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='';" /><span style="display:none;">${escapeHtml(card.visual?.icon || '◆')}</span>`
        : `<span>${escapeHtml(card.visual?.icon || '◆')}</span>`;

      inspector.innerHTML = `
        <div class="inspector-card" style="--card-accent:${cardColor(card)}">
          <div class="inspector-heading">
            <div class="detail-icon">${artContent}</div>
            <div>
              <p>${ownerTag} 몹 카드</p>
              <h2>${escapeHtml(card.name)}</h2>
            </div>
          </div>
          <div class="detail-health">
            <span>HP</span>
            <b>${mob.hp}</b>
            <small>/ ${mob.maxHp}</small>
          </div>
          <div class="health-bar"><i style="width:${hpPercent}%"></i></div>
          ${passiveHtml}
          ${attachmentsHtml}
          ${statusLineHtml}
          <div class="simplified-skill-title" style="margin-top:0.6rem;">
            <span>스킬</span>
            <small>${statusNotice}</small>
          </div>
          <div class="skill-list" style="margin-top:0.4rem;">
            ${skills}
          </div>
          ${action}
        </div>
      `;
      return;
    }

    // 2. 내 손패 카드인 경우: 상세 정보 및 직관적 사용 버튼 제공
    if (own && current.zone === 'hand') {
      let action = '';
      if (state.isMyTurn) {
        if (card.id === 'gyarados') {
          action = '<button class="button inspector-action" type="button" data-use-card style="width:100%;">인면어 위에 드래그하여 진화</button>';
        } else if (card.type === 'mob') {
          action = '<button class="button inspector-action" type="button" data-use-card style="width:100%;">필드에 배치하기</button>';
        } else if (!card.target) {
          action = '<button class="button inspector-action" type="button" data-use-card style="width:100%;">즉시 사용하기</button>';
        } else {
          action = '<button class="button inspector-action" type="button" data-use-card style="width:100%;">대상 선택하기</button>';
        }
      }

      const passiveHtml = card.passive
        ? `<div class="passive-box"><span>특성 · ${escapeHtml(card.passive.name)}</span><p>${escapeHtml(card.passive.text)}</p></div>`
        : '';

      const artContent = card.image
        ? `<img class="inspector-thumb-img" src="${cardImageUrl(card.image)}" alt="${escapeHtml(card.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='';" /><span style="display:none;">${escapeHtml(card.visual?.icon || '◆')}</span>`
        : `<span>${escapeHtml(card.visual?.icon || '◆')}</span>`;

      inspector.innerHTML = `
        <div class="inspector-card" style="--card-accent:${cardColor(card)}">
          <div class="inspector-heading">
            <div class="detail-icon">${artContent}</div>
            <div>
              <p>${card.type === 'mob' ? '몹 카드' : card.type === 'attachment' ? '부착형 아이템' : '소모형 아이템'}</p>
              <h2>${escapeHtml(card.name)}</h2>
            </div>
          </div>
          ${card.type === 'mob' ? `<div class="detail-health"><span>기본 HP</span><b>${card.hp}</b></div>` : ''}
          <p class="detail-text">${escapeHtml(card.text || '')}</p>
          ${passiveHtml}
          ${action}
        </div>
      `;
      return;
    }

    inspector.innerHTML = `<div class="inspector-empty"><span class="inspect-icon">⚔</span><strong>카드 상세 & 스킬</strong><p>필드 또는 손패의 카드를 클릭하면 상세 정보와 스킬을 사용할 수 있습니다.</p></div>`;
  }

  function statusText(mob) {
    const status = [];
    if (mob.statuses?.confusion) status.push('혼란');
    if (mob.statuses?.burn) status.push('화상');
    if (mob.statuses?.sleep) status.push('잠듦');
    if (mob.stacks?.overcharge) status.push(`과충전 ${mob.stacks.overcharge}`);
    if (mob.stacks?.fuel) status.push(`과열된 연료 ${mob.stacks.fuel}`);
    return status.length ? status.join(' · ') : '없음';
  }

  function renderLog() {
    const logs = state.logs || [];
    $('#game-log').innerHTML = logs.length ? logs.slice(0, 8).map((entry) => `<p class="log-${escapeHtml(entry.kind)}">${escapeHtml(entry.text)}</p>`).join('') : '<p class="empty-copy">아직 기록이 없습니다.</p>';
  }

  function render() {
    if (!state) return;
    const opponent = state.opponent;
    const isSetup = state.status === 'setup';
    $('#room-code').textContent = state.roomCode;
    $('#turn-count').textContent = isSetup ? '준비 단계' : `TURN ${state.turnNumber}`;
    $('#turn-announcement').textContent = state.status === 'finished'
      ? (state.winner === 'me' ? '승리했습니다!' : state.winner === 'opponent' ? '패배했습니다' : '무승부입니다')
      : state.status === 'lobby' ? '상대 입장을 기다리는 중'
      : isSetup ? (state.me.board.length === 0 ? '시작 몹을 배치하세요' : '상대방 배치 대기 중...')
      : state.status === 'coin-flip' ? '선공 결정 중...'
      : state.isMyTurn ? '나의 턴' : `${opponent?.name || '상대'}의 턴`;
    $('#turn-announcement').classList.toggle('my-turn', Boolean(state.isMyTurn));
    $('#my-name').textContent = state.me.name;
    $('#my-hand-count').textContent = state.me.handCount;
    $('#my-deck-count').textContent = state.me.deckCount;
    $('#my-trash-count').textContent = state.me.trash.length;
    $('#my-field-effect').textContent = state.me.fieldEffect === 'electric-field' ? '⚡ 전기장' : '';
    $('#my-field-effect').classList.toggle('active', Boolean(state.me.fieldEffect));
    $('#my-connection').textContent = state.me.connected ? '연결됨' : '연결 끊김';
    $('#my-board').innerHTML = boardMarkup(state.me.board, 'me');
    $('#my-hand').innerHTML = state.me.hand.map(handMarkup).join('') || '<p class="empty-hand">손패가 없습니다.</p>';

    $('#opponent-name').textContent = opponent?.name || '상대를 기다리는 중';
    $('#opponent-connection').textContent = opponent ? (opponent.connected ? '연결됨' : '재연결 대기') : '대기';
    $('#opponent-hand-count').textContent = opponent?.handCount || 0;
    $('#opponent-hand-button').innerHTML = `${renderOpponentHand(opponent?.handCount || 0)}<b>${opponent?.handCount || 0}</b>장`;
    $('#opponent-deck-count').textContent = opponent?.deckCount || 0;
    $('#opponent-trash-count').textContent = opponent?.trash.length || 0;
    $('#opponent-field-effect').textContent = opponent?.fieldEffect === 'electric-field' ? '⚡ 전기장' : '';
    $('#opponent-field-effect').classList.toggle('active', Boolean(opponent?.fieldEffect));
    $('#opponent-board').innerHTML = boardMarkup(opponent?.board || [], 'opponent');

    $('#selection-hint').textContent = selectionHint();
    $('#draw-button').disabled = !state.isMyTurn || state.me.drawUsed || state.status !== 'playing';
    $('#draw-button').classList.toggle('used', Boolean(state.me.drawUsed));
    $('#end-turn-button').disabled = !state.isMyTurn || state.status !== 'playing';
    $('#cancel-button').disabled = !selected && !pending;
    renderInspector();
    renderLog();
  }

  function chooseCard(uid, zone = 'hand') {
    selected = { uid, zone };
    pending = null;
    render();
  }

  async function doAction(payload) {
    const reply = await send('gameAction', payload);
    if (reply.ok) {
      selected = null;
      pending = null;
      render();
    }
    return reply;
  }

  function canTarget(owner) {
    const requirement = targetRequirement();
    return requirement === 'any' || (requirement === 'ally' && owner === 'me') || (requirement === 'enemy' && owner === 'opponent');
  }

  async function chooseTarget(uid, owner) {
    if (!canTarget(owner)) return false;
    if (pending?.type === 'skill') return doAction({ type: 'skill', sourceUid: pending.sourceUid, skillId: pending.skillId, targetId: uid });
    if (pending?.type === 'devour') return doAction({ type: 'devour', sourceUid: pending.sourceUid, targetId: uid });
    if (selected?.zone === 'hand') return doAction({ type: 'play', cardUid: selected.uid, targetId: uid });
    return false;
  }

  function clickBoard(event) {
    const card = event.target.closest('.game-card');
    const slot = event.target.closest('.board-slot');
    if (!slot) return;
    if (card) {
      const owner = card.dataset.owner;
      const uid = card.dataset.uid;
      if (state?.isMyTurn && canTarget(owner)) {
        chooseTarget(uid, owner);
        return;
      }
      chooseCard(uid, 'board');
      return;
    }
    if (slot.dataset.owner === 'me' && state?.isMyTurn) {
      if (selectedHandDefinition()?.type === 'mob') {
        if (selectedHandDefinition()?.id === 'gyarados') {
          showToast('갸라도스는 빈 필드에 낼 수 없습니다. 필드의 인면어 전장연을 선택해 진화시키세요.', 'error');
          return;
        }
        doAction({ type: 'play', cardUid: selected.uid });
      } else if (state.status === 'setup' && state.me.board.length === 0) {
        const mobCard = state.me.hand.find((c) => {
          const def = definition(c.cardId);
          return def?.type === 'mob' && def?.id !== 'nature-disaster' && def?.id !== 'gyarados';
        });
        if (mobCard) {
          doAction({ type: 'play', cardUid: mobCard.uid });
        }
      }
    }
  }

  function clickHand(event) {
    const card = event.target.closest('.hand-card');
    if (!card) return;
    chooseCard(card.dataset.uid, 'hand');
  }

  function playSelectedCard() {
    const current = selected && stateCard(selected.uid);
    if (!current || current.zone !== 'hand') return;
    const card = definition(current.instance.cardId);
    if (card.id === 'gyarados') {
      showToast('필드의 아군 인면어 전장연을 클릭하거나 드래그하여 진화시키세요.');
      return;
    }
    if (card.type === 'mob') {
      showToast('빈 필드를 클릭하거나 카드를 드래그해 배치하세요.');
      return;
    }
    if (!card.target) {
      doAction({ type: 'play', cardUid: current.instance.uid });
      return;
    }
    showToast('빛나는 대상 카드를 선택하세요.');
    render();
  }

  function clickInspector(event) {
    if (event.target.closest('[data-cancel-skill]')) {
      pending = null;
      render();
      return;
    }
    const skillButton = event.target.closest('[data-skill]');
    if (skillButton) {
      const source = stateCard(skillButton.dataset.source)?.instance;
      const skill = definition(source?.cardId)?.skills.find((entry) => entry.id === skillButton.dataset.skill);
      if (!skill || skillButton.disabled) return;
      if (skill.target === 'enemy') {
        pending = { type: 'skill', target: 'enemy', sourceUid: source.uid, skillId: skill.id };
        selected = { uid: source.uid, zone: 'board' };
        render();
        showToast('공격할 상대 몹을 선택하세요. (스킬 발동 후 턴 종료)');
      } else {
        doAction({ type: 'skill', sourceUid: source.uid, skillId: skill.id });
      }
      return;
    }
    if (event.target.closest('[data-use-card]')) playSelectedCard();
    if (event.target.closest('[data-evolve]')) doAction({ type: 'evolve', sourceUid: selected?.uid });
    if (event.target.closest('[data-devour]')) {
      pending = { type: 'devour', target: 'ally', sourceUid: selected?.uid };
      render();
      showToast('포식할 다른 아군 몹을 선택하세요.');
    }
  }

  function cardDetailMarkup(card, instance) {
    const isMob = card.type === 'mob';
    const skills = card.skills?.map((skill) => `<li><strong>${escapeHtml(skill.name)}</strong><span>${escapeHtml(skill.text)}</span></li>`).join('') || '';
    const passive = card.passive ? `<div class="modal-passive"><strong>특성 · ${escapeHtml(card.passive.name)}</strong><p>${escapeHtml(card.passive.text)}</p></div>` : '';
    const modalArt = card.image
      ? `<img class="card-art-img" src="${cardImageUrl(card.image)}" alt="${escapeHtml(card.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='';" /><span style="display:none;">${escapeHtml(card.visual?.icon || '◆')}</span>`
      : `<span>${escapeHtml(card.visual?.icon || '◆')}</span>`;
    return `<article class="modal-card-detail" style="--card-accent:${cardColor(card)}"><div class="modal-card-art">${modalArt}</div><div><p class="eyebrow">${isMob ? '몹 카드' : card.type === 'attachment' ? '부착형 아이템' : '소모형 아이템'}</p><h2>${escapeHtml(card.name)}</h2>${isMob ? `<p class="modal-hp">HP <b>${instance?.hp ?? card.hp}</b> / ${instance?.maxHp ?? card.hp}</p>` : `<p>${escapeHtml(card.text)}</p>`}${passive}${skills ? `<ul class="modal-skills">${skills}</ul>` : ''}</div></article>`;
  }

  function openModal(content) {
    modalContent.innerHTML = content;
    if (modal.showModal) modal.showModal();
    else modal.setAttribute('open', '');
  }

  function closeModal() {
    if (modal.close) modal.close();
    else modal.removeAttribute('open');
  }

  function openTrash(who) {
    const player = who === 'me' ? state.me : state.opponent;
    const title = who === 'me' ? '내 트레쉬' : '상대 트레쉬';
    const cardsHtml = player.trash.length ? player.trash.map((instance) => {
      const card = definition(instance.cardId);
      return `<button class="trash-entry" type="button" data-detail-card="${escapeHtml(instance.cardId)}"><span style="color:${cardColor(card)}">${escapeHtml(card?.visual?.icon || '◆')}</span><strong>${escapeHtml(card?.name || instance.cardId)}</strong><small>${escapeHtml(card?.type === 'mob' ? '몹 카드' : '아이템')}</small></button>`;
    }).join('') : '<p class="empty-copy">아직 트레쉬가 비어 있습니다.</p>';
    openModal(`<div class="pile-modal"><p class="eyebrow">PUBLIC PILE</p><h2>${title}</h2><p>트레쉬 카드는 양쪽 플레이어가 확인할 수 있습니다.</p><div class="trash-list">${cardsHtml}</div></div>`);
  }

  function openDeck(who) {
    const player = who === 'me' ? state.me : state.opponent;
    openModal(`<div class="pile-modal"><p class="eyebrow">HIDDEN PILE</p><h2>${who === 'me' ? '내 덱' : '상대 덱'}</h2><div class="deck-preview">✦</div><p>덱의 순서는 공개되지 않습니다. 남은 카드: <b>${player.deckCount}장</b></p></div>`);
  }

  function openRules() {
    openModal(`<div class="rules-modal"><p class="eyebrow">MVP RULESET</p><h2>기본 대전 규칙</h2><ul><li>게임 시작 시 손패 3장을 지급받고(최소 1장 몹 보장), 시작 몹 1장을 배치합니다.</li><li>동전 던지기로 선공과 후공을 결정합니다.</li><li>내 턴에는 덱에서 한 번 드로우하고, 몹을 최대 3장까지 필드에 배치할 수 있습니다.</li><li>몹의 스킬을 사용하면 스킬 발동 후 자동으로 턴이 상대에게 넘어갑니다.</li><li>마지막 필드 몹이 사라지면 패배합니다.</li></ul><h3>키워드</h3><p><b>과충전</b>은 최대 10스택입니다. <b>혼란</b>과 <b>화상</b>은 동전 판정으로 처리됩니다. <b>전기장</b>은 내 필드의 과충전 획득량을 2배로 만듭니다.</p></div>`);
  }

  let turnSplashTimer;
  function showTurnSplash(event) {
    const splashEl = $('#turn-splash');
    if (!splashEl) return;
    clearTimeout(turnSplashTimer);

    const isMe = event.activeSeat === state?.me?.seat || event.activeName === state?.me?.name;
    splashEl.className = `turn-splash-overlay ${isMe ? 'my-turn' : 'opponent-turn'}`;
    splashEl.innerHTML = `
      <div class="turn-splash-box">
        <h1 class="turn-splash-title">${isMe ? 'YOUR TURN' : 'OPPONENT TURN'}</h1>
        <span class="turn-splash-subtitle">TURN ${event.turnNumber || state?.turnNumber || 1} · ${escapeHtml(event.activeName || '')}</span>
      </div>
    `;
    splashEl.classList.remove('hidden');

    turnSplashTimer = setTimeout(() => {
      splashEl.classList.add('hidden');
    }, 1500);
  }

  let coinTossTimer;
  function showCoinToss(event) {
    const coinEl = $('#coin-toss-screen');
    if (!coinEl) return;
    clearTimeout(coinTossTimer);

    const isFirst = event.firstSeat === state?.me?.seat || event.firstName === state?.me?.name;
    coinEl.innerHTML = `
      <h2>선공 결정 동전 던지기</h2>
      <div class="coin-3d-wrapper">
        <div class="coin-3d-disc">${event.heads ? '앞' : '뒤'}</div>
      </div>
      <div class="coin-result-message">${escapeHtml(event.firstName)} 님의 선공! (${isFirst ? '내가 선공' : '상대방 선공'})</div>
    `;
    coinEl.classList.remove('hidden');

    coinTossTimer = setTimeout(() => {
      coinEl.classList.add('hidden');
    }, 2500);
  }

  function enqueueEffect(event) {
    effectQueue.push(event);
    if (!showingEffect) displayNextEffect();
  }

  function displayNextEffect() {
    const event = effectQueue.shift();
    if (!event) {
      showingEffect = false;
      effectLayer.innerHTML = '';
      return;
    }
    showingEffect = true;

    if (event.type === 'first-coin') {
      showCoinToss(event);
    } else if (event.type === 'turn-change') {
      showTurnSplash(event);
    }

    const type = escapeHtml(event.type || 'effect');
    const title = escapeHtml(event.title || event.result || '효과');
    const text = escapeHtml(event.text || (event.amount ? `${event.amount}` : ''));
    const specialCoin = event.type === 'coin' ? `<span class="coin ${event.heads ? 'heads' : 'tails'}">${event.heads ? '앞' : '뒤'}</span>` : '';
    effectLayer.innerHTML = `<div class="effect-banner effect-${type}">${specialCoin}<strong>${title}</strong>${text ? `<small>${text}</small>` : ''}</div>`;
    [event.targetId, event.sourceId].filter(Boolean).forEach((uid) => {
      document.querySelectorAll(`[data-uid="${CSS.escape(uid)}"]`).forEach((element) => element.classList.add('effect-active'));
    });

    let duration = 900;
    if (event.type === 'first-coin') duration = 2500;
    else if (event.type === 'turn-change') duration = 1400;
    else if (event.type === 'play-mob' || event.type === 'attach' || event.type === 'item') duration = 1300;
    else if (event.type === 'special' || event.type === 'end') duration = 1500;

    setTimeout(() => {
      document.querySelectorAll('.effect-active').forEach((element) => element.classList.remove('effect-active'));
      displayNextEffect();
    }, duration);
  }

  function copyRoomCode() {
    const code = state?.roomCode;
    if (!code) return;
    const invite = `${location.origin}${location.pathname}?room=${code}`;
    navigator.clipboard?.writeText(invite).then(() => showToast('초대 링크를 복사했습니다.')).catch(() => showToast(`방 코드: ${code}`));
  }

  nameInput.addEventListener('input', () => {
    localStorage.setItem('goa-player-name', nameInput.value.trim());
  });

  $('#open-play-button')?.addEventListener('click', openPlayModal);
  $('#play-dialog-close')?.addEventListener('click', closePlayModal);
  $('#start-matchmaking-button')?.addEventListener('click', startMatchmaking);
  $('#cancel-matchmaking-button')?.addEventListener('click', cancelMatchmaking);
  playDialog?.addEventListener('click', (event) => {
    if (event.target === playDialog) closePlayModal();
  });

  $('#open-deck-builder-button')?.addEventListener('click', openDeckBuilder);
  $('#deck-dialog-close')?.addEventListener('click', closeDeckBuilder);
  $('#deck-reset-button')?.addEventListener('click', () => {
    currentCustomDeck = [...DEFAULT_DECK];
    saveDeckToStorage();
    renderDeckBuilder();
    showToast('기본 덱으로 복원되었습니다.');
  });
  $('#deck-save-button')?.addEventListener('click', () => {
    if (currentCustomDeck.length < 10 || currentCustomDeck.length > 20) {
      showToast('덱은 10장 이상 20장 이하이어야 합니다.', 'error');
      return;
    }
    const hasMob = currentCustomDeck.some((id) => {
      const def = definition(id);
      return def?.type === 'mob' && id !== 'nature-disaster' && id !== 'gyarados';
    });
    if (!hasMob) {
      showToast('덱에 시작 몹 카드가 최소 1장 이상 있어야 합니다. (갸라도스/자연재해 제외)', 'error');
      return;
    }
    saveDeckToStorage();
    closeDeckBuilder();
    showToast('덱 편성이 저장되었습니다.');
  });
  deckDialog?.addEventListener('click', (event) => {
    if (event.target === deckDialog) closeDeckBuilder();
    const addCardEl = event.target.closest('[data-add-card]');
    if (addCardEl) {
      addCardToDeck(addCardEl.dataset.addCard);
      return;
    }
    const removeCardEl = event.target.closest('[data-remove-card]');
    if (removeCardEl) {
      removeCardFromDeck(removeCardEl.dataset.removeCard);
      return;
    }
  });

  $('#create-button').addEventListener('click', createRoom);
  $('#join-button').addEventListener('click', joinRoom);
  $('#lobby-form')?.addEventListener('submit', (event) => { event.preventDefault(); openPlayModal(); });
  roomInput.addEventListener('input', () => { roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
  $('#room-code-button').addEventListener('click', copyRoomCode);
  $('#draw-button').addEventListener('click', () => doAction({ type: 'draw' }));
  $('#end-turn-button').addEventListener('click', () => doAction({ type: 'endTurn' }));
  $('#cancel-button').addEventListener('click', () => { selected = null; pending = null; render(); });
  $('#my-board').addEventListener('click', clickBoard);
  $('#opponent-board').addEventListener('click', clickBoard);
  $('#my-hand').addEventListener('click', clickHand);
  $('#inspector').addEventListener('click', clickInspector);
  $('#my-trash-button').addEventListener('click', () => openTrash('me'));
  $('#opponent-trash-button').addEventListener('click', () => openTrash('opponent'));
  $('#my-deck-button').addEventListener('click', () => openDeck('me'));
  $('#opponent-deck-button').addEventListener('click', () => openDeck('opponent'));
  $('#rules-button').addEventListener('click', openRules);
  $('#logo-button').addEventListener('click', openRules);
  $('#opponent-hand-button').addEventListener('click', () => showToast('상대 손패의 내용은 공개되지 않습니다.'));
  $('#modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal();
    const detail = event.target.closest('[data-detail-card]');
    if (detail) {
      const card = definition(detail.dataset.detailCard);
      if (card) openModal(cardDetailMarkup(card));
    }
  });

  $('#my-hand').addEventListener('dragstart', (event) => {
    const card = event.target.closest('.hand-card');
    if (!card || !state?.isMyTurn) {
      event.preventDefault();
      return;
    }
    const uid = card.dataset.uid;
    event.dataTransfer.setData('text/plain', uid);
    event.dataTransfer.effectAllowed = 'move';
    selected = { uid, zone: 'hand' };
    render();
  });

  function handleDragOver(event) {
    if (!state?.isMyTurn) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }

  function handleDrop(event) {
    if (!state?.isMyTurn) return;
    event.preventDefault();
    const uid = event.dataTransfer.getData('text/plain') || selected?.uid;
    if (!uid) return;
    const current = stateCard(uid);
    if (!current || current.zone !== 'hand') return;
    const cardDef = definition(current.instance.cardId);
    if (!cardDef) return;

    const targetCardEl = event.target.closest('.game-card');
    const targetSlotEl = event.target.closest('.board-slot');

    // 1. 드롭 대상이 필드의 몹 카드인 경우
    if (targetCardEl) {
      const targetUid = targetCardEl.dataset.uid;
      const targetOwner = targetCardEl.dataset.owner;
      const targetMob = stateCard(targetUid)?.instance;

      // 1-1. 갸라도스를 아군 인면어 전장연 위에 드롭 -> 진화
      if (cardDef.id === 'gyarados') {
        if (targetOwner === 'me' && targetMob?.cardId === 'face-fish') {
          if (targetMob.placedTurn !== null && targetMob.placedTurn !== undefined && targetMob.placedTurn === state.turnNumber) {
            showToast('인면어 전장연을 배치한 턴에는 바로 진화할 수 없습니다.', 'error');
            return;
          }
          doAction({ type: 'play', cardUid: uid, targetId: targetUid });
        } else {
          showToast('인면어 전장연 위에 드롭하여 진화시켜야 합니다.', 'error');
        }
        return;
      }

      // 1-2. 부착형 아이템을 아군 몹에 드롭 -> 부착
      if (cardDef.type === 'attachment') {
        if (targetOwner === 'me') {
          doAction({ type: 'play', cardUid: uid, targetId: targetUid });
        } else {
          showToast('부착 아이템은 아군 몹에게만 사용할 수 있습니다.', 'error');
        }
        return;
      }

      // 1-3. 소모형 아이템을 몹에 드롭
      if (cardDef.type === 'consumable') {
        if (!cardDef.target) {
          doAction({ type: 'play', cardUid: uid });
          return;
        }
        if (cardDef.target === 'ally' && targetOwner !== 'me') {
          showToast('아군 몹에게만 사용할 수 있습니다.', 'error');
          return;
        }
        if (cardDef.target === 'enemy' && targetOwner !== 'opponent') {
          showToast('상대 몹에게만 사용할 수 있습니다.', 'error');
          return;
        }
        doAction({ type: 'play', cardUid: uid, targetId: targetUid });
        return;
      }

      showToast('빈 필드 슬롯에 드롭하세요.', 'error');
      return;
    }

    // 2. 드롭 대상이 필드 슬롯인 경우
    if (targetSlotEl) {
      const slotOwner = targetSlotEl.dataset.owner;
      if (slotOwner === 'me') {
        if (cardDef.id === 'gyarados') {
          showToast('갸라도스는 빈 필드에 낼 수 없습니다. 필드의 인면어 전장연 위에 드롭하세요.', 'error');
          return;
        }
        if (cardDef.type === 'mob') {
          doAction({ type: 'play', cardUid: uid });
          return;
        }
        if (cardDef.type === 'consumable' && !cardDef.target) {
          doAction({ type: 'play', cardUid: uid });
          return;
        }
        showToast('대상이 필요한 아이템입니다. 대상 몹 위에 드롭하세요.', 'error');
        return;
      }
    }

    // 3. 대상 없는 소모품을 필드 아무 곳에나 드롭한 경우
    if (cardDef.type === 'consumable' && !cardDef.target) {
      doAction({ type: 'play', cardUid: uid });
    }
  }

  $('#my-board').addEventListener('dragover', handleDragOver);
  $('#opponent-board').addEventListener('dragover', handleDragOver);
  $('#my-board').addEventListener('drop', handleDrop);
  $('#opponent-board').addEventListener('drop', handleDrop);

  Promise.all([loadDefinitions()]).then(() => {
    initSocket();
    const savedRoom = localStorage.getItem('goa-room-code');
    const savedName = localStorage.getItem('goa-player-name');
    if (savedRoom && savedName && !urlRoom) {
      activeRoomCode = savedRoom;
    }
  });
})();
