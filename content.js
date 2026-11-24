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
// Бейдж и плитки истории — shadow DOM на собственных тегах (eloup-badge,
// eloup-tile): FACEIT перекрашивает button/span страницы важными
// объявлениями (так плитки становились белыми), а внутрь тени не достаёт.
//
// Диагностика бейджей и иконок — логами [ELOUP] в консоль страницы:
// ростер → список на lookup → ответ сервера → сколько бейджей повешено.

const MATCH_URL = /\/cs2\/room\/(1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const HISTORY_URL = /\/players\/[^/]+\/(stats\/|cs2\/history)/;
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
    // Поля из разведки 23.11 (demoUrl/demoUrls — camelCase с Accept json+camelcase)
    const link = payload.demo_url
        || payload.demoUrl
        || payload.demoUrls?.[0]
        || payload.demoURLs?.[0]
        || payload.demo_download_url
        || payload.assets?.['demo-url']
        || payload.assets?.vpgame?.demo;

    if (!link) {
        throw new Error('Демка ещё не обработана — попробуйте позже');
    }

    return link;
}

// Ростер матча (разведка 24.11): в ответе match/v2 фракции лежат сразу в
// payload.teams — без промежуточного «factions» из Data API v4, а SteamID64
// игрока — поле gameId. Варианты v4 оставлены фолбэками: вдруг FACEIT
// вернёт старую схему на другом эндпойнте
function rosterOf(payload) {
    const factions = payload?.teams?.factions ?? payload?.teams;

    return [
        ...(factions?.faction1?.roster ?? []),
        ...(factions?.faction2?.roster ?? []),
    ];
}

function playerSteamId(entry) {
    return entry?.gameId || entry?.game_player_id || entry?.steam_id_64 || entry?.steam_id64 || null;
}

function debug(message) {
    console.log(`[ELOUP] ${message}`);
}

// POST подписи — единственный эндпойнт, на котором FACEIT ставит капчу:
// серию быстрых запросов он читает как бот-паттерн
async function signPost(resource) {
    const response = await fetch('https://www.faceit.com/api/download/v2/demos/download-url', {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            // Так подписывает сам сайт (разведка 23.11): без faceit-referer
            // и camelcase-акцепта эндпойнт ведёт себя непредсказуемо
            Accept: 'application/json+camelcase',
            'faceit-referer': 'web-next',
        },
        body: JSON.stringify({ resourceUrl: resource }),
    });

    if (response.status === 403) {
        throw Object.assign(new Error('captcha'), { captcha: true });
    }

    if (!response.ok) {
        throw new Error(`FACEIT не подписал ссылку (${response.status})`);
    }

    const url = (await response.json().catch(() => null))?.payload?.downloadUrl;

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
            button, a { background: #ccff00; color: #0a0c10; }
            a { display: none; }
            button:hover:not(:disabled), a:hover { filter: brightness(1.08); }
            button:disabled { opacity: .55; cursor: default; }
        </style>
        <button type="button"><span></span></button>
        <a target="_blank" rel="noopener">Открыть разбор на ELOUP.GG</a>
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

// Ошибка не висит на кнопке вечно: через 8 секунд она снова готова к нажатию
function setError(text) {
    setText(text);

    setTimeout(() => {
        if (uiState.phase === 'text' && uiState.text === text) {
            reset();
        }
    }, 8000);
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
        anchorMount.host.style.cssText = 'display:block;width:100%;margin:8px 0;';
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

        for (const player of rosterOf(payload)) {
            if (playerSteamId(player) === meSteamId) {
                return player?.nickname || player?.game_player_name || player?.gameName || null;
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
                    setError(state.error);
                }
            });
        })
        .catch((e) => setError(String(e.message || e)));
}

// ---- Бейджи ELOUP у игроков комнаты ----------------------------------------

let roomPlayers = new Map(); // ник FACEIT (lower) → запись ELOUP { nickname, profile|null }
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
        debug(`бейджи: из кэша ${roomPlayers.size} игрок(ов) ELOUP`);
        bindBadges();

        return;
    }

    playersLoadedFor = matchId;

    try {
        // Ростер — из кэша матча: бейджи не добавляют FACEIT ни одного запроса.
        // Ник + SteamID64: сервер ищет зарегистрированных по обоим — SteamID
        // матчит даже когда ник ELOUP не совпадает с ником FACEIT
        const payload = await matchPayload(matchId);
        const roster = rosterOf(payload);
        const seen = new Set();
        const players = [];

        for (const entry of roster) {
            const nickname = entry?.nickname || entry?.game_player_name || null;
            const steamId = playerSteamId(entry);

            if (!nickname || seen.has(nickname.toLowerCase())) {
                continue;
            }

            seen.add(nickname.toLowerCase());
            players.push({ nickname, steam_id: steamId });

            if (players.length === 10) {
                break;
            }
        }

        debug(`ростер: ${roster.length}, на lookup уходит ${players.length} (${players.map((p) => p.nickname).join(', ') || '—'})`);

        if (!players.length) {
            debug('ростер пуст — бейджей не будет: FACEIT снова сменил структуру ответа');

            return;
        }

        chrome.runtime.sendMessage({ type: 'eloup-lookup', players }, (state) => {
            // Бейджи — необязательная витрина: без токена или при сбое тихо уходим
            const failure = chrome.runtime.lastError?.message || state?.error;

            if (chrome.runtime.lastError || !state || !state.auth || state.error) {
                debug(`lookup не прошёл: ${failure || 'нет ответа'}`);

                return;
            }

            const found = (state.players || []).filter((player) => player.eloup);

            debug(`ELOUP знает ${found.length} из ${players.length}: ${found.map((p) => p.nickname).join(', ') || '—'}`);

            roomPlayers = new Map(found.map((player) => [player.nickname.toLowerCase(), player]));
            cacheSet(key, found, PLAYERS_TTL);
            bindBadges();
        });
    } catch (e) {
        // Матч скрыт — бейджей не будет, кнопка от них не зависит
        debug(`ростер не прочитан: ${e.message || e}`);
    }
}

// ---- Фирменный знак ---------------------------------------------------------

// Знак ELOUP — ломаная роста с четырьмя узлами, как в логотипе. Цвет берёт
// из currentColor, поэтому одна и та же разметка служит и тёмной плашке
// с жёлтым знаком, и жёлтой с тёмным
const MARK_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 9 11 13 14 20 6"/><g fill="currentColor" stroke="none"><circle cx="4" cy="17" r="2"/><circle cx="9" cy="11" r="2"/><circle cx="13" cy="14" r="2"/><circle cx="20" cy="6" r="2"/></g></svg>';

// Палитра сайта: жёлтый на почти чёрном
const BRAND_BG = '#ccff00';
const BRAND_INK = '#0a0c10';
const BRAND_DARK = '#16181d';
const BRAND_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

// Всё фирменное живёт в shadow DOM: FACEIT перекрашивает кнопки и плашки
// страницы своим CSS с !important (так плитки «E» в истории становились
// белыми), а внутрь тени его правила не достают. Обратное неверно: важные
// объявления страницы сильнее :host, поэтому хост — собственный тег
// (eloup-tile / eloup-badge): правила FACEIT по тегам button, a, span на
// него не попадают, и страница не закрасит подложку под плиткой.
// `all: initial` на хосте обрезает наследование — шрифт и цвет страницы
// внутрь не просачиваются
const HOST_RESET = 'all:initial;display:inline-flex;vertical-align:middle;';

// css — стили конкретной плашки, дописываются после сброса хоста
function brandRoot(host, css) {
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `<style>:host{${HOST_RESET}}${css}</style>`;

    return root;
}

function badgeEl(entry) {
    const host = document.createElement('eloup-badge');

    host.dataset.eloupBadge = entry.nickname;

    // Отступ — на кнопке внутри тени, а не на хосте: страницы с !important
    // (margin: 0 у FACEIT) перешибают :host, а внутрь тени не достают
    const root = brandRoot(host, `
        button {
            all: unset;
            margin-left: 6px;
            box-sizing: border-box;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 7px 2px 5px;
            border-radius: 4px;
            background: ${BRAND_BG};
            color: ${BRAND_INK};
            font: 800 10px/1.4 ${BRAND_FONT};
            letter-spacing: .04em;
            text-transform: uppercase;
            white-space: nowrap;
            cursor: pointer;
            transition: filter .15s ease;
        }
        button:hover { filter: brightness(1.08); }
        button:focus-visible { outline: 2px solid ${BRAND_INK}; outline-offset: 1px; }
        .mark { display: inline-flex; }
    `);

    const button = document.createElement('button');

    button.type = 'button';
    button.title = 'Игрок ELOUP.GG — нажмите для карточки';
    button.innerHTML = `<span class="mark">${MARK_SVG}</span><span class="label"></span>`;
    button.querySelector('.label').textContent = entry.profile?.roles?.length ? `ELOUP · ${entry.profile.roles[0]}` : 'ELOUP';
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showPopover(entry, host);
    });

    root.append(button);

    return host;
}

// Ник в комнате — текстовый лист: React не даёт стабильных классов, ищем
// совпадение текста у элементов без вложенных тегов. Ключ карты игроков —
// ник в нижнем регистре, поэтому текст страницы сравниваем так же без
// регистра: иначе «---hiddeN» никогда не равен «---hidden» и бейджа нет
function nicknameElements(nick) {
    const found = [];
    const wanted = nick.toLowerCase();

    for (const el of document.querySelectorAll('span, div, a, p')) {
        if (!el.childElementCount && (el.textContent || '').trim().toLowerCase() === wanted && !el.closest('[data-eloup-badge]')) {
            found.push(el);
        }
    }

    return found;
}

function bindBadges() {
    if (!roomPlayers.size || !currentMatch) {
        return;
    }

    let bound = 0;

    for (const [nick, player] of roomPlayers) {
        const spots = nicknameElements(nick);

        if (!spots.length) {
            debug(`ник «${player.nickname}» не нашёлся в вёрстке комнаты`);
        }

        for (const el of spots) {
            if (el.nextElementSibling?.dataset?.eloupBadge === player.nickname) {
                continue;
            }

            el.after(badgeEl(player));
            bound++;
        }
    }

    if (bound) {
        debug(`бейджи: повешено ${bound}`);
    }
}

// ---- Карточка игрока -------------------------------------------------------

let popoverHost = null;

function showPopover(entry, anchorEl) {
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
            h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 4px; font-size: 15px; }
            .mark { display: inline-flex; flex: 0 0 auto; color: #ccff00; }
            .muted { color: #9d9fa5; font-size: 12px; }
            .row { margin: 6px 0; font-size: 12px; }
            .roles { color: #ccff00; font-weight: 700; }
            a.button {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                margin-top: 12px;
                padding: 9px 12px;
                border-radius: 4px;
                background: #ccff00;
                color: #0a0c10;
                font-weight: 700;
                text-decoration: none;
            }
            a.button .mark { color: #0a0c10; }
        </style>
        <div class="card">
            <h3><span class="mark">${MARK_SVG}</span><span class="nick"></span></h3>
            <div class="name muted"></div>
            <div class="row roles"></div>
            <div class="row map muted"></div>
            <div class="row hl muted"></div>
            <a class="button" target="_blank" rel="noopener"><span class="mark">${MARK_SVG}</span>Профиль на ELOUP.GG</a>
        </div>
    `;

    const card = root.querySelector('.card');
    const profile = entry.profile;

    root.querySelector('.nick').textContent = entry.nickname;

    if (profile) {
        root.querySelector('.name').textContent = profile.name && profile.name !== entry.nickname ? profile.name : '';
        root.querySelector('.roles').textContent = (profile.roles || []).join(' · ');
        root.querySelector('.map').textContent = profile.favorite_map ? `Любимая карта: ${profile.favorite_map}` : '';
        root.querySelector('.hl').textContent = profile.highlights_count ? `Хайлайтов: ${profile.highlights_count}` : '';
        root.querySelector('a.button').href = profile.profile_url;
    } else {
        // Зарегистрирован, но профиль скрыт: без согласия личность не раскрываем
        root.querySelector('.name').textContent = 'Игрок зарегистрирован на ELOUP.GG, профиль скрыт';
        root.querySelector('a.button').style.display = 'none';
    }

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

const TITLE_IDLE = 'Разобрать демку на ELOUP';
const TITLE_DONE = 'Открыть разбор на ELOUP';

// Плитка строки истории. Готовность — тёмная плитка с жёлтым знаком; готовый
// разбор — плитка, залитая жёлтым (ссылка); в работе — знак мигает; сбой —
// красный «!», причина в тултипе. Состояния переключает объект tile: его же
// использует прогресс из фона, когда строку перерисовал React
function historyTile(matchId) {
    const host = document.createElement('eloup-tile');

    host.dataset.eloupRow = matchId;

    const root = brandRoot(host, `
        button, a {
            all: unset;
            margin-left: 8px; // внутри тени: margin: 0 !important страницы сюда не достаёт
            box-sizing: border-box;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            border: 1px solid rgba(204, 255, 0, .35);
            border-radius: 6px;
            background: ${BRAND_DARK};
            color: ${BRAND_BG};
            cursor: pointer;
            transition: background .15s ease, color .15s ease, border-color .15s ease;
        }
        button:hover:not(:disabled) { border-color: ${BRAND_BG}; }
        button:disabled { cursor: default; }
        button:focus-visible, a:focus-visible { outline: 2px solid ${BRAND_BG}; outline-offset: 2px; }
        a { display: none; background: ${BRAND_BG}; color: ${BRAND_INK}; border-color: ${BRAND_BG}; }
        .mark { display: inline-flex; }
        button.busy .mark { animation: pulse 1s ease-in-out infinite; }
        button.error { color: #ff8f8f; border-color: rgba(255, 143, 143, .5); }
        .bang { font: 900 13px/1 ${BRAND_FONT}; }
        @keyframes pulse { 50% { opacity: .3; } }
    `);

    const button = document.createElement('button');
    const link = document.createElement('a');

    button.type = 'button';
    button.innerHTML = `<span class="mark">${MARK_SVG}</span>`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.innerHTML = `<span class="mark">${MARK_SVG}</span>`;

    const tile = {
        working: false,
        idle() {
            link.style.display = 'none';
            button.style.display = 'inline-flex';
            button.disabled = false;
            button.className = '';
            button.querySelector('.mark').innerHTML = MARK_SVG;
            button.title = TITLE_IDLE;
        },
        busy(title) {
            link.style.display = 'none';
            button.style.display = 'inline-flex';
            button.disabled = true;
            button.className = 'busy';
            button.querySelector('.mark').innerHTML = MARK_SVG;
            button.title = title;
        },
        error(message) {
            link.style.display = 'none';
            button.style.display = 'inline-flex';
            button.disabled = false;
            button.className = 'error';
            button.querySelector('.mark').innerHTML = '<span class="bang">!</span>';
            button.title = message;
        },
        done(url) {
            button.style.display = 'none';
            link.href = url;
            link.title = TITLE_DONE;
            link.querySelector('.mark').innerHTML = MARK_SVG;
            link.style.display = 'inline-flex';
        },
    };

    button.addEventListener('click', () => historyStart(tile, matchId));

    tile.idle();
    root.append(button, link);

    // paintHistory находит плитку по data-eloup-row — так она получает доступ к состояниям
    host.eloupTile = tile;

    return host;
}

async function historyStart(tile, matchId) {
    if (tile.working) {
        return;
    }

    tile.working = true;
    tile.busy('Получаем ссылку на демку');

    try {
        const [downloadUrl, focusNickname] = await Promise.all([signedDemoUrl(matchId), myMatchNickname(matchId)]);

        tile.busy('Передаём на ELOUP');

        chrome.runtime.sendMessage({ type: 'eloup-analyze', matchId, downloadUrl, focusNickname }, (state) => {
            if (chrome.runtime.lastError || !state) {
                tile.working = false;
                tile.idle();

                return;
            }

            if (state.error) {
                tile.working = false;
                tile.error(state.error);
            }
        });
    } catch (e) {
        tile.working = false;
        tile.error(String(e.message || e));
    }
}

// Известный статус красит строку: готово — жёлтая плитка-ссылка на разбор,
// в работе — мигающий знак
function paintHistory(matchId) {
    const known = historyKnown.get(matchId);

    if (!known) {
        return;
    }

    const tile = document.querySelector(`[data-eloup-row="${matchId}"]`)?.eloupTile;

    if (!tile) {
        return;
    }

    if (known.status === 'done') {
        tile.working = false;
        tile.done(known.url);
    } else if (known.status === 'queued' || known.status === 'parsing') {
        tile.working = true;
        tile.busy('Разбирается на ELOUP');
    }
}

// Ячейка строки, куда встаёт иконка: в истории FACEIT строка — сетка div,
// а не таблица, и ссылка на матч работает с display: contents. Вставляем в
// последнюю MatchTableCell, чтобы иконка осталась в потоке своей строки, а
// не падала в конец списка. Хеши классов styled-components нестабильны —
// матчим по стабильной части имени
function historyCell(row) {
    return row.querySelector(':scope > [class*="MatchTableCell"]:last-of-type') || row;
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

        // Строка истории — сама ссылка на комнату (display: contents), её
        // ячейки — грид-элементы. Раньше closest('tr,li,[role="row"]') на
        // такой вёрстке возвращал null и fallback брал родителя ссылки — то
        // есть контейнер всего списка, и иконки сбивались под список
        const row = link.closest('tr, li, [role="row"]') || link.closest('a[href*="/room/"]') || link.parentElement;

        if (row && !rows.has(match[1])) {
            rows.set(match[1], row);
        }
    }

    if (!rows.size) {
        return;
    }

    for (const [matchId, row] of rows) {
        if (!row.querySelector(`[data-eloup-row="${matchId}"]`)) {
            historyCell(row).append(historyTile(matchId));
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
            setError(message.message);
        }
    }

    // История: плитка строки показывает процент, а по завершении
    // строка перекрашивается ссылкой на разбор
    const tile = message.matchId
        ? document.querySelector(`[data-eloup-row="${message.matchId}"]`)?.eloupTile
        : null;

    if (tile) {
        if (message.phase === 'download' || message.phase === 'upload') {
            const prefix = message.phase === 'download' ? 'Скачиваем демку: ' : 'Передаём на ELOUP: ';

            tile.busy(`${prefix}${message.percent}%`);
        } else if (message.phase === 'error') {
            tile.working = false;
            tile.error(message.message);
        }
    }

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







