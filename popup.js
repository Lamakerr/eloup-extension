// Попап расширения: токен и адрес сайта, проверка связи с ELOUP.

const DEFAULT_SERVER = 'https://eloup.gg';

const tokenInput = document.getElementById('token');
const serverInput = document.getElementById('server');
const saveButton = document.getElementById('save');
const status = document.getElementById('status');

async function load() {
    const { token = '', server = DEFAULT_SERVER } = await chrome.storage.local.get(['token', 'server']);

    tokenInput.value = token;
    serverInput.value = server || DEFAULT_SERVER;
}

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
    } catch (e) {
        status.className = 'err';
        status.textContent = String(e.message || e);
    } finally {
        saveButton.disabled = false;
    }
});

load();
