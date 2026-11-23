// Фоновый воркер расширения ELOUP (#258): транспортный агент.
// Качает демку FACEIT с сессией игрока (демки — приватный ресурс, серверу
// ELOUP они недоступны) и передаёт её на eloup.gg кусками, не сохраняя файл
// на диск целиком: fetch → буфер 8 МиБ → POST.

const DEFAULT_SERVER = 'https://eloup.gg';

// Кандидаты эндпоинтов ссылки на демку (уточнены разведкой, см. README):
// пробуем по очереди, берём первый ответивший адресом
const DEMO_LINK_SOURCES = [
    {
        url: (matchId) => `https://api.faceit.com/demos/v1/download-link?match_id=${matchId}`,
        pick: (json) => json?.download_link ?? json?.payload?.download_link ?? null,
    },
    {
        url: (matchId) => `https://api.faceit.com/match/v2/match/${matchId}`,
        pick: (json) => json?.payload?.demo_url ?? json?.demo_url ?? null,
    },
];

// Одна передача за раз: параллельные загрузки демок не нужны
let busy = false;

// ---- Настройки ------------------------------------------------------------

async function settings() {
    const { token = '', server = DEFAULT_SERVER } = await chrome.storage.local.get(['token', 'server']);

    return { token, server: (server || DEFAULT_SERVER).replace(/\/+$/, '') };
}

async function api(path, options = {}) {
    const { token, server } = await settings();

    const response = await fetch(server + path, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(options.headers || {}) },
    });

    const json = await response.json().catch(() => ({}));

    return { response, json };
}

// ---- Состояние ------------------------------------------------------------

async function getState(matchId) {
    const { json, response } = await api(`/api/extension/state${matchId ? `?match_ids=${encodeURIComponent(matchId)}` : ''}`);

    if (response.status === 401) {
        return { auth: false };
    }

    if (!response.ok) {
        return { auth: true, error: json.error || `ELOUP ответил ${response.status}` };
    }

    return {
        auth: true,
        user: json.user,
        upload: json.upload,
        known: (json.matches || [])[0] || null,
    };
}

// ---- Ссылка на демку ------------------------------------------------------

async function demoLink(matchId) {
    for (const source of DEMO_LINK_SOURCES) {
        try {
            const response = await fetch(source.url(matchId), { credentials: 'include', headers: { Accept: 'application/json' } });

            if (!response.ok) {
                continue;
            }

            const link = source.pick(await response.json().catch(() => null));

            if (link) {
                return link;
            }
        } catch {
            // Следующий кандидат — вдруг этот эндпоинт у FACEIT переименовали
        }
    }

    throw new Error('FACEIT не отдал ссылку на демку. Убедитесь, что вы вошли на faceit.com и демка матча доступна');
}

// ---- Передача демки -------------------------------------------------------

async function report(tabId, state) {
    if (tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: 'eloup-progress', ...state }).catch(() => {});
    }
}

async function transfer(matchId, tabId) {
    const state = await getState(matchId);

    if (!state.auth) {
        throw new Error('Нет токена ELOUP — создайте его в настройках профиля, вкладка «Катки»');
    }

    if (state.error) {
        throw new Error(state.error);
    }

    if (state.known) {
        // Матч уже на ELOUP — открываем готовый разбор
        report(tabId, { phase: 'done', url: state.known.url });

        return;
    }

    report(tabId, { phase: 'link' });

    const link = await demoLink(matchId);

    report(tabId, { phase: 'download', percent: 0 });

    const response = await fetch(link, { credentials: 'include' });

    if (!response.ok || !response.body) {
        throw new Error(`FACEIT не отдал демку (${response.status})`);
    }

    const total = Number(response.headers.get('content-length')) || 0;
    const chunkSize = Math.min(state.upload?.chunk_size || 8 * 1024 * 1024, 8 * 1024 * 1024);
    const maxBytes = state.upload?.max_bytes || 1024 * 1024 * 1024;

    const uploadId = crypto.randomUUID();
    const reader = response.body.getReader();

    let buffer = new Uint8Array(chunkSize);
    let filled = 0;
    let received = 0;
    let offset = 0;
    let sent = false;

    const flush = async () => {
        const form = new FormData();

        form.append('match_id', matchId);
        form.append('upload_id', uploadId);
        form.append('offset', String(offset));
        form.append('total_size', String(received));
        form.append('chunk', new Blob([buffer.subarray(0, filled)]));

        const { response: r, json } = await api('/api/extension/demos', { method: 'POST', body: form });

        if (r.status === 409 && json.uploaded !== undefined) {
            // Кусок не на своём месте: дубль или гонка. Потоковый пайп не умеет
            // отматывать назад — передача начнётся заново с новым идентификатором
            throw Object.assign(new Error('restart'), { restart: true });
        }

        if (!r.ok) {
            throw new Error(json.error || `ELOUP ответил ${r.status}`);
        }

        offset += filled;
        buffer = new Uint8Array(chunkSize);
        filled = 0;
        sent = true;

        return json;
    };

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        if (received + value.length > maxBytes) {
            throw new Error('Демка больше лимита ELOUP');
        }

        received += value.length;

        if (total) {
            report(tabId, { phase: 'download', percent: Math.round((received / total) * 100) });
        }

        let cursor = 0;

        while (cursor < value.length) {
            const take = Math.min(chunkSize - filled, value.length - cursor);

            buffer.set(value.subarray(cursor, cursor + take), filled);
            filled += take;
            cursor += take;

            if (filled === chunkSize) {
                const result = await flush();

                report(tabId, { phase: 'upload', percent: Math.round((offset / Math.max(received, 1)) * 100) });

                if (result.done) {
                    report(tabId, { phase: 'done', url: result.url });

                    return;
                }
            }
        }
    }

    if (filled === 0 && sent) {
        // Файл уложился ровно в границу куска: сервер уже закрыл передачу
        const check = await getState(matchId);

        if (check.known) {
            report(tabId, { phase: 'done', url: check.known.url });

            return;
        }

        throw new Error('Передача оборвалась — нажмите кнопку ещё раз');
    }

    const result = await flush();

    report(tabId, { phase: 'done', url: result.url });
}

// ---- Шина сообщений -------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'eloup-check') {
        getState(message.matchId).then(sendResponse);

        return true;
    }

    if (message?.type === 'eloup-analyze') {
        if (busy) {
            sendResponse({ error: 'Демка уже передаётся — дождитесь её' });

            return true;
        }

        busy = true;
        const tabId = sender?.tab?.id ?? null;

        transfer(message.matchId, tabId)
            .catch(async (e) => {
                // Сдвиг куска: один рестарт с чистым идентификатором, дальше — ошибка
                if (e.restart) {
                    report(tabId, { phase: 'link' });

                    return transfer(message.matchId, tabId);
                }

                throw e;
            })
            .catch((e) => report(tabId, { phase: 'error', message: String(e.message || e) }))
            .finally(() => { busy = false; });

        sendResponse({ started: true });

        return true;
    }
});
