// Кнопка «Разобрать на ELOUP» на странице матча FACEIT (#258).
// FACEIT — SPA: адрес меняется без перезагрузки, поэтому следим за ним
// периодически и попstate-ом. Кнопка плавающая (правый нижний угол): не
// зависит от вёрстки FACEIT и переживает её обновления. Стили — в shadow DOM,
// чтобы не конфликтовать со страницей.

const MATCH_URL = /\/cs2\/room\/(1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

const SETTINGS_URL = 'https://eloup.gg/profile/settings/premier';

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

    button().addEventListener('click', () => {
        if (!currentMatch) {
            return;
        }

        setBusy('Готовим…');

        chrome.runtime.sendMessage({ type: 'eloup-analyze', matchId: currentMatch }, (response) => {
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

// Статусы передачи от фонового воркера
chrome.runtime.onMessage.addListener((message) => {
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
