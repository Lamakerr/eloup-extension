// Попап расширения: токен и адрес сайта, проверка связи с ELOUP и тумблер
// ИИ-автоматизации для PLUS/staff.

const DEFAULT_SERVER = 'https://eloup.gg';

const tokenInput = document.getElementById('token');
const serverInput = document.getElementById('server');
const saveButton = document.getElementById('save');
const status = document.getElementById('status');
const aiSection = document.getElementById('ai');
const aiToggle = document.getElementById('aiToggle');
const aiHint = document.getElementById('aiHint');
const aiConsentLink = document.getElementById('aiConsentLink');

async function load() {
    const { token = '', server = DEFAULT_SERVER, aiAuto = false } = await chrome.storage.local.get(['token', 'server', 'aiAuto']);

    tokenInput.value = token;
    serverInput.value = server || DEFAULT_SERVER;
    aiToggle.checked = !!aiAuto;
    // Положение тумблера уже выставлено — с этого момента его можно анимировать
    aiSection.classList.add('ready');

    await refreshAi();
}

// Тумблер «каждый разбор сразу на ИИ» (#288): сервер показывает его только
// PLUS/staff. Без согласия на передачу данных ИИ разбор не запустится —
// мягко ведём подтвердить его на сайте
async function refreshAi() {
    aiSection.hidden = true;
    aiHint.hidden = true;

    const { token = '', server = DEFAULT_SERVER } = await chrome.storage.local.get(['token', 'server']);

    if (!token) {
        return;
    }

    try {
        const response = await fetch(`${(server || DEFAULT_SERVER).replace(/\/+$/, '')}/api/extension/state`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });

        if (!response.ok) {
            return;
        }

        const ai = (await response.json()).ai_review;

        if (!ai?.can) {
            return;
        }

        aiSection.hidden = false;

        if (!ai.consent) {
            aiConsentLink.href = `${(server || DEFAULT_SERVER).replace(/\/+$/, '')}/demo`;
            aiHint.hidden = false;
        }
    } catch {
        // Сайт недоступен — тумблер просто не показываем
    }
}

aiToggle.addEventListener('change', () => {
    chrome.storage.local.set({ aiAuto: aiToggle.checked });
});

saveButton.addEventListener('click', async () => {
    const token = tokenInput.value.trim();
    const server = (serverInput.value.trim() || DEFAULT_SERVER).replace(/\/+$/, '');

    saveButton.disabled = true;
    status.className = '';
    status.textContent = 'Проверяем…';

    try {
        const response = await fetch(`${server}/api/extension/state`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });

        if (response.status === 401) {
            throw new Error('Токен не принят — создайте новый в настройках профиля, вкладка «Катки»');
        }

        if (!response.ok) {
            throw new Error(`Сайт ответил ${response.status}`);
        }

        const json = await response.json();

        await chrome.storage.local.set({ token, server });

        status.className = 'ok';
        status.textContent = `Связь есть. Аккаунт: ${json.user?.name || 'игрок'}`;

        await refreshAi();
    } catch (e) {
        status.className = 'err';
        status.textContent = String(e.message || e);
    } finally {
        saveButton.disabled = false;
    }
});

load();
