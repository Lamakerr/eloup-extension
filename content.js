// Кнопка «Разобрать на ELOUP» на странице матча FACEIT (#258).
// FACEIT — SPA: адрес меняется без перезагрузки, поэтому следим за ним
// периодически и попstate-ом. Кнопка плавающая (правый нижний угол): не
// зависит от вёрстки FACEIT и переживает её обновления. Стили — в shadow DOM,
// чтобы не конфликтовать со страницей.

const MATCH_URL = /\/cs2\/room\/(1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const SETTINGS_URL = 'https://eloup.gg/profile/settings/premier';

// ---- Подписанная ссылка на демку (разведка 23.11, детали в README) ---------

// В данных матча лежит неподписанный resourceUrl (его хост намеренно не
// резолвится), а подписывается он POST-ом download-url с куками сессии.
// Запросы идут со страницы матча — same-origin, родные куки, referer и origin,
// максимально похоже на поведение самого сайта.

async function resourceUrl(matchId) {
    const response = await fetch(`https://api.faceit.com/match/v2/match/${matchId}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error(`FACEIT не отдал данные матча (${response.status})`);
    }

    const payload = (await response.json().catch(() => null))?.payload || {};
    const link = payload.demo_url ?? payload.demoUrl ?? payload.demoUrls?.[0] ?? payload.demoURLs?.[0] ?? null;

    if (!link) {
        throw new Error('В данных матча нет демки — она ещё не обработана или недоступна');
    }

    return link;
}

async function signedDemoUrl(matchId) {
    // Сайт прикладает заголовок x-faceit-captcha-token (Cloudflare Turnstile).
    // Первый прогон идёт без него: если FACEIT отвечает 403 — сюда добавится
    // инжект Turnstile из main world (README, «Капча»).
    const response = await fetch('https://www.faceit.com/api/download/v2/demos/download-url', {
        method: 'POST',
        credentials: 'include',
        headers: {
            Accept: 'application/json+camelcase',
            'Content-Type': 'application/json',
            'faceit-referer': 'web-next',
        },
        body: JSON.stringify({ resourceUrl: await resourceUrl(matchId) }),
    });

    if (response.status === 403) {
        throw new Error('FACEIT требует капчу для ссылки на демку — сообщите в ELOUP');
    }

    if (!response.ok) {
        throw new Error(`FACEIT не подписал ссылку на демку (${response.status})`);
    }

    const url = (await response.json().catch(() => null))?.payload?.downloadUrl;

    if (!url) {
        throw new Error('FACEIT не подписал ссылку на демку — попробуйте ещё раз');
    }

    return url;
}

let host = null;
let shadow = null;
let currentMatch = null;
let checkedMatch = null;

function findMatchId() {
    const match = document.location.pathname.match(MATCH_URL);

    return match ? match[1] : null;
}

// ---- Кнопка ----------------------------------------------------------------

function button() {
    return shadow?.querySelector('button') || null;
}

function label() {
    return shadow?.querySelector('span') || null;
}

function buildButton() {
    host = document.createElement('div');
    host.id = 'eloup-ext-button';
    host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483646;';

    shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
        <style>
            button {
                all: initial;
                font-family: Inter, Arial, sans-serif;
                display: inline-flex;
                align-items: center;
                gap: 8px;
                height: 44px;
                padding: 0 18px;
                border: 0;
                border-radius: 12px;
                background: #ccff00;
                color: #101319;
                font-size: 13px;
                font-weight: 800;
                letter-spacing: 0.02em;
                cursor: pointer;
                box-shadow: 0 8px 24px rgba(0,0,0,.35);
            }
            button:hover { filter: brightness(1.05); }
            button:disabled { background: #23262f; color: #9aa1ad; cursor: default; }
            a {
                font-family: Inter, Arial, sans-serif;
                display: none;
                align-items: center;
                height: 44px;
                padding: 0 18px;
                border-radius: 12px;
                background: #ccff00;
                color: #101319;
                font-size: 13px;
                font-weight: 800;
                text-decoration: none;
                box-shadow: 0 8px 24px rgba(0,0,0,.35);
            }
            a:hover { filter: brightness(1.05); }
        </style>
        <button type="button" hidden><span>Разобрать на ELOUP</span></button>
        <a target="_blank" rel="noopener"></a>
    `;

    button().addEventListener('click', async () => {
        if (!currentMatch) {
            return;
        }

        setBusy('Получаем ссылку…');

        let downloadUrl;

        try {
            downloadUrl = await signedDemoUrl(currentMatch);
        } catch (e) {
            setText(String(e.message || e));
            setTimeout(() => reset(), 6000);

            return;
        }

        setBusy('Качаем демку… 0%');

        chrome.runtime.sendMessage({ type: 'eloup-analyze', matchId: currentMatch, downloadUrl }, (response) => {
            if (chrome.runtime.lastError) {
                return;
            }

            if (response?.error) {
                setText(response.error);
                setTimeout(() => reset(), 4000);
            }
        });
    });

    document.documentElement.appendChild(host);
}

function setText(text) {
    const el = label();

    if (el) {
        el.textContent = text;
    }
}

function setBusy(text) {
    const el = button();

    if (el) {
        el.disabled = true;

        if (text) {
            setText(text);
        }
    }
}

function reset() {
    const el = button();

    if (el) {
        el.disabled = false;
        setText('Разобрать на ELOUP');
    }
}

// Статусы передачи от фонового воркера и запросы свежей подписи (TTL ссылки — 5 минут)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'eloup-resign') {
        if (message.matchId !== currentMatch) {
            sendResponse({ error: 'Вкладка матча уже закрыта — откройте её и попробуйте снова' });
        } else {
            setBusy('Обновляем ссылку…');
            signedDemoUrl(message.matchId)
                .then(sendResponse)
                .catch((e) => sendResponse({ error: String(e.message || e) }));
        }

        return true; // ответ уйдёт асинхронно
    }

    if (!message?.type || message.type !== 'eloup-progress' || !host) {
        return;
    }

    switch (message.phase) {
        case 'link':
            setBusy('Ищем демку…');
            break;
        case 'download':
            setBusy(`Качаем демку… ${message.percent ?? 0}%`);
            break;
        case 'upload':
            setBusy(`Отдаём на ELOUP… ${message.percent ?? 0}%`);
            break;
        case 'done':
            done(message.url || 'https://eloup.gg/profile');
            break;
        case 'error':
            setText(message.message || 'Не получилось');
            setTimeout(() => reset(), 5000);
            break;
    }
});

function done(url) {
    if (!shadow) {
        return;
    }

    const link = shadow.querySelector('a');
    const el = button();

    if (link) {
        link.href = url;
        link.textContent = '✓ Разбор готов — открыть';
        link.style.display = 'inline-flex';
    }

    if (el) {
        el.style.display = 'none';
    }
}

// ---- Жизненный цикл --------------------------------------------------------

async function check(matchId) {
    checkedMatch = matchId;

    chrome.runtime.sendMessage({ type: 'eloup-check', matchId }, (state) => {
        if (chrome.runtime.lastError || !state || checkedMatch !== matchId) {
            return;
        }

        if (!state.auth) {
            setBusy('Настройте ELOUP');
            button()?.addEventListener('click', () => window.open(SETTINGS_URL, '_blank'), { once: true });

            return;
        }

        if (state.known) {
            done(state.known.url);

            return;
        }

        reset();
    });
}

function tick() {
    const matchId = findMatchId();

    if (matchId === currentMatch) {
        return;
    }

    currentMatch = matchId;

    if (!matchId) {
        if (host) {
            host.remove();
            host = null;
            shadow = null;
        }

        return;
    }

    if (!host) {
        buildButton();
    }

    reset();
    check(matchId);
}

setInterval(tick, 1000);
window.addEventListener('popstate', tick);
tick();
