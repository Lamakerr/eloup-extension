// Контент-скрипт расширения ELOUP (#258, #288) на страницах FACEIT.
//
// Что делает:
//   • комната матча — кнопка «Разобрать на ELOUP» под «СМОТРЕТЬ ДЕМО»
//     (плавающая, если FACEIT переставил вёрстку) и бейдж «ELOUP · роль»
//     у игроков, зарегистрированных на платформе;
//   • история матчей — кнопка быстрого разбора в каждой строке;
//   • подписанные ссылки на демки: кэш, дедупликация и анти-флуд — FACEIT
//     стал присаживать запросы на капчу (403 на download-url, 23.11).
//
// FACEIT — SPA на React: DOM появляется и пропадает без перезагрузок,
// за якорями следит MutationObserver, за адресом — интервал и popstate.
// Стили — в shadow DOM, чтобы не конфликтовать со страницей.

const MATCH_URL = /\/cs2\/room\/(1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const HISTORY_URL = /\/players\/[^/]+\/stats\//;
const SETTINGS_URL = 'https://eloup.gg/profile/settings/premier';

const MATCH_TTL = 10 * 60 * 1000; // JSON матча: ростер для бейджей, ссылка на демку
const LINK_TTL = 4 * 60 * 1000; // подпись FACEIT живёт ~5 минут
const PLAYERS_TTL = 10 * 60 * 1000;
const SIGN_INTERVAL = 15 * 1000; // минимум между запросами подписи
const ANCHOR_GRACE = 4000; // сколько ждём «СМОТРЕТЬ ДЕМО» до плавающей кнопки

// ---- Кэш -------------------------------------------------------------------

// sessionStorage переживает перезагрузку SPA, но не вкладку: подписи не
// протухнут между матчами, а память не течёт
function cacheGet(key) {
    try {
        const raw = sessionStorage.getItem(key);

        if (!raw) {
            return null;
        }

        const { value, expires } = JSON.parse(raw);

        return expires > Date.now() ? value : null;
    } catch {
        return null;
    }
}

function cacheSet(key, value, ttl) {
    try {
        sessionStorage.setItem(key, JSON.stringify({ value, expires: Date.now() + ttl }));
    } catch {
        // Приватный режим — просто без кэша
    }
}

// JSON матча: один fetch на матч, конкурентные вызовы делят один промис
const matchInflight = new Map();

async function matchPayload(matchId) {
    const key = `eloup-match:${matchId}`;
    const cached = cacheGet(key);

    if (cached) {
        return cached;
    }

    if (!matchInflight.has(matchId)) {
        matchInflight.set(matchId, (async () => {
            const response = await fetch(`https://api.faceit.com/match/v2/match/${matchId}`, {
                credentials: 'include',
                headers: { Accept: 'application/json' },
            });

            if (!response.ok) {
                throw new Error(`FACEIT не отдал данные матча (${response.status})`);
            }

            const payload = (await response.json().catch(() => null))?.payload || null;

            if (!payload) {
                throw new Error('FACEIT не отдал данные матча');
            }

            cacheSet(key, payload, MATCH_TTL);

            return payload;
        })().finally(() => matchInflight.delete(matchId)));
    }

    return matchInflight.get(matchId);
}

async function resourceUrl(matchId) {
    const payload = await matchPayload(matchId);
    const link = payload.demo_url
        || payload.demo_download_url
        || payload.assets?.['demo-url']
        || payload.assets?.vpgame?.demo;

    if (!link) {
        throw new Error('Демка ещё не обработана — попробуйте позже');
    }

    return link;
}

// POST подписи — единственный эндпойнт, на котором FACEIT ставит капчу:
// серию быстрых запросов он читает как бот-паттерн
async function signPost(resource) {
    const response = await fetch('https://www.faceit.com/api/download/v2/demos/download-url', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ resource }),
    });

    if (response.status === 403) {
        throw Object.assign(new Error('captcha'), { captcha: true });
    }

    if (!response.ok) {
        throw new Error(`FACEIT не подписал ссылку (${response.status})`);
    }

    const url = (await response.json().catch(() => null))?.download_url;

    if (!url) {
        throw new Error('FACEIT не подписал ссылку');
    }

    return url;
}

let lastSignAt = 0;

async function signedDemoUrl(matchId, { allowRetry = true } = {}) {
    const key = `eloup-link:${matchId}`;
    const cached = cacheGet(key);

    if (cached) {
        return cached;
    }

    const resource = await resourceUrl(matchId);

    // Анти-флуд: клики и рестарты схлопываются в один ритм запросов
    const wait = lastSignAt + SIGN_INTERVAL - Date.now();

    if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
    }

    lastSignAt = Date.now();

    try {
        const url = await signPost(resource);
        cacheSet(key, url, LINK_TTL);

        return url;
    } catch (e) {
        // Челлендж обычно снимается сам за полминуты — один автоповтор,
        // вторая капча подряд значит «нужен человек»
        if (e.captcha && allowRetry) {
            await new Promise((resolve) => setTimeout(resolve, 30 * 1000));

            return signedDemoUrl(matchId, { allowRetry: false });
        }

        if (e.captcha) {
            // Челлендж у FACEIT невидимый и руками капчу не видно: проходит
            // клик по родной «СМОТРЕТЬ ДЕМО» — он валидирует браузер
            throw new Error('FACEIT просит проверку: нажмите «СМОТРЕТЬ ДЕМО» на странице, а затем нашу кнопку ещё раз');
        }

        throw e;
    }
}

// ---- Кнопка «Разобрать на ELOUP» -------------------------------------------

const DEFAULT_TEXT = 'Разобрать на ELOUP';

let uiState = { phase: 'idle', text: DEFAULT_TEXT, url: null };
let anchorMount = null; // кнопка под «СМОТРЕТЬ ДЕМО»
let floatingMount = null; // аварийная, правый нижний угол
let anchorTimer = null;

function mountPoint(kind) {
    const host = document.createElement('div');

    host.dataset.eloupMounted = '1';

    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
        <style>
            button, a {
                box-sizing: border-box;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 100%;
                height: 44px;
                border: none;
                border-radius: 4px;
                padding: 0 16px;
                font: 700 14px/1 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
                text-decoration: none;
                cursor: pointer;
                transition: filter .15s ease;
                user-select: none;
            }
            button { background: #ccff00; color: #0a0c10; }
            a { background: #17b26a; color: #fff; display: none; }
            button:hover:not(:disabled), a:hover { filter: brightness(1.08); }
            button:disabled { opacity: .55; cursor: default; }
        </style>
        <button type="button"><span></span></button>
        <a target="_blank" rel="noopener">Открыть разбор</a>
    `;

    const mount = { host, root, button: root.querySelector('button'), link: root.querySelector('a'), kind };

    mount.button.addEventListener('click', onAnalyzeClick);

    if (kind === 'floating') {
        host.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483646;width:220px;box-shadow:0 6px 24px rgba(0,0,0,.5);border-radius:4px;';
    }

    return mount;
}

function applyState() {
    for (const mount of [anchorMount, floatingMount]) {
        if (!mount?.host.isConnected) {
            continue;
        }

        const span = mount.button.querySelector('span');

        if (uiState.phase === 'done') {
            mount.button.style.display = 'none';
            mount.link.href = uiState.url;
            mount.link.style.display = 'inline-flex';
        } else {
            mount.link.style.display = 'none';
            mount.button.style.display = 'inline-flex';
            mount.button.disabled = uiState.phase === 'busy';
            span.textContent = uiState.text;
        }
    }
}

function setBusy(text) {
    uiState = { phase: 'busy', text };
    applyState();
}

function setSetup(text) {
    uiState = { phase: 'setup', text };
    applyState();
}

function setText(text) {
    uiState = { phase: 'text', text };
    applyState();
}

function reset() {
    uiState = { phase: 'idle', text: DEFAULT_TEXT, url: null };
    applyState();
}

function done(url) {
    uiState = { phase: 'done', text: null, url };
    applyState();
}

// ---- Комната матча ---------------------------------------------------------

const DEMO_ANCHOR_TEXT = /^\s*(смотреть демо|watch demo)\s*$/i;

let currentMatch = null;
let checkedMatch = null;
let authKnown = null; // null — не спрашивали, false/true — ответ ELOUP
let meSteamId = null; // SteamID64 аккаунта ELOUP: по нему находим свой ник FACEIT в ростере

function findDemoAnchor() {
    for (const el of document.querySelectorAll('button, a')) {
        if (DEMO_ANCHOR_TEXT.test(el.textContent || '')) {
            return el;
        }
    }

    return null;
}

function removeFloating() {
    floatingMount?.host.remove();
    floatingMount = null;
}

function scanAnchor() {
    if (!currentMatch) {
        return;
    }

    // Кнопку срезал React — точка повисла в воздухе
    if (anchorMount && !anchorMount.host.isConnected) {
        anchorMount = null;
    }

    if (anchorMount) {
        return;
    }

    const anchor = findDemoAnchor();

    if (anchor) {
        clearTimeout(anchorTimer);
        anchorTimer = null;
        removeFloating();

        anchorMount = mountPoint('anchor');
        anchorMount.host.style.cssText = 'display:block;width:100%;margin-top:8px;';
        anchor.parentElement.insertBefore(anchorMount.host, anchor.nextSibling);
        applyState();
    }
}

// Вёрстку FACEIT перевернули — через 4 секунды поднимаем плавающую кнопку
function scheduleFloating() {
    if (anchorTimer || anchorMount || floatingMount) {
        return;
    }

    anchorTimer = setTimeout(() => {
        anchorTimer = null;

        if (!anchorMount && currentMatch && !floatingMount) {
            floatingMount = mountPoint('floating');
            document.documentElement.append(floatingMount.host);
            applyState();
        }
    }, ANCHOR_GRACE);
}

function check(matchId) {
    chrome.runtime.sendMessage({ type: 'eloup-check', matchId }, (state) => {
        if (chrome.runtime.lastError || !state) {
            return;
        }

        authKnown = state.auth;

        if (!state.auth) {
            setSetup('Настроить ELOUP');
        } else if (state.error) {
            setText('ELOUP недоступен');
        } else {
            // Фокус разбора — ник FACEIT: сервер отдает SteamID аккаунта,
            // ростер матча по нему скажет, под каким ником игрок записан в демке
            meSteamId = state.user?.steam_id || null;

            if (state.known) {
                done(state.known.url);
            }
        }
    });
}

// Свой ник FACEIT в этом матче: ростер знает SteamID64 (game_player_id) и ник.
// Под ним игрок записан в демке FACEIT — это фокус разбора на ELOUP
async function myMatchNickname(matchId) {
    if (!meSteamId) {
        return null;
    }

    try {
        const payload = await matchPayload(matchId);
        const roster = [
            ...(payload?.teams?.factions?.faction1?.roster ?? []),
            ...(payload?.teams?.factions?.faction2?.roster ?? []),
        ];

        for (const player of roster) {
            if ([player?.game_player_id, player?.steam_id_64, player?.steam_id64].includes(meSteamId)) {
                return player?.nickname || player?.game_player_name || null;
            }
        }
    } catch {
        // Ростер недоступен — фокус уточнит сервер по самой демке (SteamID)
    }

    return null;
}

function onAnalyzeClick(event) {
    event.preventDefault();

    if (uiState.phase === 'setup' || authKnown === false) {
        window.open(SETTINGS_URL, '_blank', 'noopener');

        return;
    }

    if (uiState.phase === 'busy' || !currentMatch) {
        return;
    }

    setBusy('Получаем ссылку…');

    // Ссылка и фокус-ник независимы — качаем параллельно
    Promise.all([signedDemoUrl(currentMatch), myMatchNickname(currentMatch)])
        .then(([downloadUrl, focusNickname]) => {
            setBusy('Передаём на ELOUP…');

            chrome.runtime.sendMessage({ type: 'eloup-analyze', matchId: currentMatch, downloadUrl, focusNickname }, (state) => {
                if (chrome.runtime.lastError || !state) {
                    reset();

                    return;
                }

                if (state.error) {
                    setText(state.error);
                }
            });
        })
        .catch((e) => setText(String(e.message || e)));
}

// ---- Бейджи ELOUP у игроков комнаты ----------------------------------------

let roomPlayers = new Map(); // ник (lower) → публичный профиль ELOUP
let playersLoadedFor = null;

async function loadRoomPlayers(matchId) {
    if (playersLoadedFor === matchId) {
        return;
    }

    const key = `eloup-players:${matchId}`;
    const cached = cacheGet(key);

    if (cached) {
        playersLoadedFor = matchId;
        roomPlayers = new Map(cached.map((player) => [player.nickname.toLowerCase(), player]));

        return;
    }

    playersLoadedFor = matchId;

    try {
        // Ростер — из кэша матча: бейджи не добавляют FACEIT ни одного запроса
        const payload = await matchPayload(matchId);
        const roster = [
            ...(payload?.teams?.factions?.faction1?.roster ?? []),
            ...(payload?.teams?.factions?.faction2?.roster ?? []),
        ];
        const nicknames = [...new Set(roster.map((p) => p?.nickname).filter(Boolean))].slice(0, 10);

        if (!nicknames.length) {
            return;
        }

        chrome.runtime.sendMessage({ type: 'eloup-lookup', nicknames }, (state) => {
            // Бейджи — необязательная витрина: без токена или при сбое тихо уходим
            if (chrome.runtime.lastError || !state || !state.auth || state.error) {
                return;
            }

            roomPlayers = new Map((state.players || []).map((player) => [player.nickname.toLowerCase(), player]));
            cacheSet(key, state.players || [], PLAYERS_TTL);
            bindBadges();
        });
    } catch {
        // Матч скрыт — бейджей не будет, кнопка от них не зависит
    }
}

function badgeEl(player) {
    const badge = document.createElement('span');

    badge.dataset.eloupBadge = player.nickname;
    badge.textContent = player.roles?.length ? `ELOUP · ${player.roles[0]}` : 'ELOUP';
    badge.title = 'Игрок ELOUP.GG — нажмите для карточки';
    badge.style.cssText = [
        'display:inline-block',
        'margin-left:6px',
        'padding:1px 6px',
        'border-radius:4px',
        'background:#ccff00',
        'color:#0a0c10',
        "font:800 10px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
        'letter-spacing:.04em',
        'text-transform:uppercase',
        'cursor:pointer',
        'vertical-align:middle',
    ].join(';');
    badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showPopover(player, badge);
    });

    return badge;
}

// Ник в комнате — текстовый лист: React не даёт стабильных классов, ищем
// точное совпадение текста у элементов без вложенных тегов
function nicknameElements(nick) {
    const found = [];

    for (const el of document.querySelectorAll('span, div, a, p')) {
        if (!el.childElementCount && (el.textContent || '').trim() === nick && !el.closest('[data-eloup-badge]')) {
            found.push(el);
        }
    }

    return found;
}

function bindBadges() {
    if (!roomPlayers.size || !currentMatch) {
        return;
    }

    for (const [nick, player] of roomPlayers) {
        for (const el of nicknameElements(nick)) {
            if (el.nextElementSibling?.dataset?.eloupBadge === player.nickname) {
                continue;
            }

            el.after(badgeEl(player));
        }
    }
}

// ---- Карточка игрока -------------------------------------------------------

let popoverHost = null;

function showPopover(player, anchorEl) {
    popoverHost?.remove();

    popoverHost = document.createElement('div');

    const root = popoverHost.attachShadow({ mode: 'open' });

    root.innerHTML = `
        <style>
            .card {
                position: fixed;
                z-index: 2147483647;
                width: 280px;
                box-sizing: border-box;
                padding: 16px;
                border-radius: 8px;
                background: #16181d;
                color: #e9eaec;
                font: 400 13px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
                box-shadow: 0 12px 40px rgba(0, 0, 0, .6);
            }
            h3 { margin: 0 0 4px; font-size: 15px; }
            .muted { color: #9d9fa5; font-size: 12px; }
            .row { margin: 6px 0; font-size: 12px; }
            .roles { color: #ccff00; font-weight: 700; }
            a.button {
                display: block;
                margin-top: 12px;
                padding: 9px 12px;
                border-radius: 4px;
                background: #ccff00;
                color: #0a0c10;
                font-weight: 700;
                text-align: center;
                text-decoration: none;
            }
        </style>
        <div class="card">
            <h3></h3>
            <div class="name muted"></div>
            <div class="row roles"></div>
            <div class="row map muted"></div>
            <div class="row hl muted"></div>
            <a class="button" target="_blank" rel="noopener">Профиль на ELOUP.GG</a>
        </div>
    `;

    const card = root.querySelector('.card');

    root.querySelector('h3').textContent = player.nickname;
    root.querySelector('.name').textContent = player.name !== player.nickname ? player.name : '';
    root.querySelector('.roles').textContent = (player.roles || []).join(' · ');
    root.querySelector('.map').textContent = player.favorite_map ? `Любимая карта: ${player.favorite_map}` : '';
    root.querySelector('.hl').textContent = player.highlights_count ? `Хайлайтов: ${player.highlights_count}` : '';

    root.querySelector('a.button').href = player.profile_url;

    // Не выезжаем за экран: позиция от бейджа с отступом от краёв
    const rect = anchorEl.getBoundingClientRect();

    card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 296))}px`;
    card.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 240))}px`;

    document.documentElement.append(popoverHost);

    // Закрытие — клик мимо карточки
    setTimeout(() => {
        document.addEventListener('pointerdown', function close(event) {
            if (!popoverHost?.contains(event.target)) {
                popoverHost?.remove();
                popoverHost = null;
                document.removeEventListener('pointerdown', close);
            }
        });
    }, 0);
}

// ---- История матчей --------------------------------------------------------

const historyKnown = new Map(); // matchId → { status, url }
const historyAsked = new Set(); // matchId → статусы уже спрашивали

const ICON_BASE = [
    'flex:0 0 auto',
    'width:24px',
    'height:24px',
    'margin-left:8px',
    'border:none',
    'border-radius:6px',
    'font:800 12px/1 system-ui,sans-serif',
    'cursor:pointer',
    'display:inline-flex',
    'align-items:center',
    'justify-content:center',
    'text-decoration:none',
    'box-sizing:border-box',
].join(';');

function historyIcon(matchId) {
    const button = document.createElement('button');

    button.dataset.eloupRow = matchId;
    button.type = 'button';
    button.title = 'Разобрать демку на ELOUP';
    button.textContent = 'E';
    button.style.cssText = `${ICON_BASE}background:#ccff00;color:#0a0c10;`;
    button.addEventListener('click', () => historyStart(button, matchId));

    return button;
}

async function historyStart(button, matchId) {
    if (button.disabled) {
        return;
    }

    button.disabled = true;
    button.textContent = '…';
    button.title = 'Получаем ссылку на демку';

    try {
        const [downloadUrl, focusNickname] = await Promise.all([signedDemoUrl(matchId), myMatchNickname(matchId)]);

        button.textContent = '↑';
        button.title = 'Передаём на ELOUP';

        chrome.runtime.sendMessage({ type: 'eloup-analyze', matchId, downloadUrl, focusNickname }, (state) => {
            if (chrome.runtime.lastError || !state) {
                historyIdle(button);

                return;
            }

            if (state.error) {
                button.textContent = '!';
                button.title = state.error;
                button.disabled = false;
            }
        });
    } catch (e) {
        button.textContent = '!';
        button.title = String(e.message || e);
        button.disabled = false;
    }
}

function historyIdle(button) {
    button.disabled = false;
    button.textContent = 'E';
    button.title = 'Разобрать демку на ELOUP';
}

// Известный статус красит строку: готово — зелёная ссылка на разбор,
// в работе — серый индикатор
function paintHistory(matchId) {
    const known = historyKnown.get(matchId);

    if (!known) {
        return;
    }

    const button = document.querySelector(`[data-eloup-row="${matchId}"]`);

    if (!button) {
        return;
    }

    if (known.status === 'done') {
        const link = document.createElement('a');

        link.dataset.eloupRow = matchId;
        link.href = known.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.title = 'Открыть разбор на ELOUP';
        link.textContent = 'E✓';
        link.style.cssText = `${ICON_BASE}background:#17b26a;color:#fff;`;
        button.replaceWith(link);

        return;
    }

    if (known.status === 'queued' || known.status === 'parsing') {
        button.disabled = true;
        button.textContent = '…';
        button.title = 'Разбирается на ELOUP';
        button.style.background = '#3a3f47';
        button.style.color = '#9d9fa5';
    }
}

function historyScan() {
    if (!HISTORY_URL.test(location.pathname)) {
        return;
    }

    const rows = new Map();

    for (const link of document.querySelectorAll('a[href*="/room/"]')) {
        const match = (link.getAttribute('href') || '').match(MATCH_URL);

        if (!match) {
            continue;
        }

        const row = link.closest('tr, li, [role="row"]') || link.parentElement;

        if (row && !rows.has(match[1])) {
            rows.set(match[1], row);
        }
    }

    if (!rows.size) {
        return;
    }

    for (const [matchId, row] of rows) {
        if (!row.querySelector(`[data-eloup-row="${matchId}"]`)) {
            row.append(historyIcon(matchId));
        }
    }

    // Новые строки — статусы батчем по 20 (потолок сервера)
    const fresh = [...rows.keys()].filter((matchId) => !historyAsked.has(matchId));

    for (let i = 0; i < fresh.length; i += 20) {
        const batch = fresh.slice(i, i + 20);

        batch.forEach((matchId) => historyAsked.add(matchId));

        chrome.runtime.sendMessage({ type: 'eloup-check-many', matchIds: batch }, (state) => {
            if (chrome.runtime.lastError || !state || !state.auth || state.error) {
                batch.forEach((matchId) => historyAsked.delete(matchId)); // можно переспросить

                return;
            }

            for (const match of state.matches || []) {
                historyKnown.set(match.match_id, match);
                paintHistory(match.match_id);
            }
        });
    }
}

// ---- Прогресс из фона ------------------------------------------------------

chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'eloup-progress') {
        return;
    }

    // Комната: кнопка обновляется для текущего матча
    if (currentMatch && message.matchId === currentMatch) {
        if (message.phase === 'download' || message.phase === 'upload') {
            const prefix = message.phase === 'download' ? 'Скачиваем демку: ' : 'Передаём на ELOUP: ';

            setBusy(`${prefix}${message.percent}%`);
        } else if (message.phase === 'done') {
            done(message.url);
        } else if (message.phase === 'error') {
            setText(message.message);
        }
    }

    // История: строку с этим матчем перекрашиваем по завершении
    if (message.phase === 'done' && message.matchId && message.url) {
        historyKnown.set(message.matchId, { status: 'done', url: message.url });
        paintHistory(message.matchId);
    }
});

// ---- Жизненный цикл страницы ----------------------------------------------

function teardownRoom() {
    anchorMount?.host.remove();
    anchorMount = null;
    removeFloating();

    clearTimeout(anchorTimer);
    anchorTimer = null;

    currentMatch = null;
    checkedMatch = null;
    roomPlayers = new Map();
    playersLoadedFor = null;

    reset();
}

function enterRoom(matchId) {
    currentMatch = matchId;
    reset();
    scheduleFloating();
    check(matchId);
    loadRoomPlayers(matchId);
}

function tick() {
    const match = location.pathname.match(MATCH_URL);

    if (match && match[1] !== currentMatch) {
        if (currentMatch) {
            teardownRoom();
        }

        enterRoom(match[1]);
    }

    scanAnchor();

    if (HISTORY_URL.test(location.pathname)) {
        historyScan();
    }
}

// React перерисовывает комнату без смены адреса — кнопку, бейджи и строки
// истории перевешиваем по мутациям, но не чаще раза в секунду
let scanQueued = false;

new MutationObserver(() => {
    if (scanQueued) {
        return;
    }

    scanQueued = true;

    setTimeout(() => {
        scanQueued = false;
        scanAnchor();
        bindBadges();
        historyScan();
    }, 1000);
}).observe(document.body, { childList: true, subtree: true });

setInterval(tick, 1000);
window.addEventListener('popstate', tick);
tick();







