// Фоновый воркер расширения ELOUP (#258): транспортный агент.
// Подписанную ссылку на демку добывает контент-скрипт на странице матча —
// там живёт сессия FACEIT (демки — приватный ресурс, серверу ELOUP они
// недоступны). Фон только передаёт файл на eloup.gg кусками, не сохраняя
// его на диск целиком: fetch → буфер 8 МиБ → POST.

const DEFAULT_SERVER = 'https://eloup.gg';

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

// ---- Свежая подпись ссылки -------------------------------------------------

// Ссылки FACEIT на демки подписанные и живут ~5 минут (X-Amz-Expires=299),
// поэтому при повторной передаче подпись запрашивается у страницы матча заново.
async function resign(tabId, matchId) {
    const link = await chrome.tabs.sendMessage(tabId, { type: 'eloup-resign', matchId });

    if (!link || link.error) {
        throw new Error(link?.error || 'Не удалось обновить ссылку на демку — нажмите кнопку ещё раз');
    }

    return link;
}

// ---- Передача демки -------------------------------------------------------

async function report(tabId, state) {
    if (tabId != null) {
        chrome.tabs.sendMessage(tabId, { type: 'eloup-progress', ...state }).catch(() => {});
    }
}

async function transfer(matchId, tabId, link) {
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

    report(tabId, { phase: 'download', percent: 0 });

    // Подписанный URL публичный (S3 + подпись в query) — куки FACEIT не нужны
    const response = await fetch(link);

    if (!response.ok || !response.body) {
        throw new Error(`CDN FACEIT не отдал демку (${response.status}) — ссылка живёт 5 минут, нажмите кнопку ещё раз`);
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

        transfer(message.matchId, tabId, message.downloadUrl)
            .catch(async (e) => {
                // Сдвиг куска: один рестарт с чистым идентификатором и свежей
                // подписью FACEIT, дальше — ошибка
                if (e.restart) {
                    return transfer(message.matchId, tabId, await resign(tabId, message.matchId));
                }

                throw e;
            })
            .catch((e) => report(tabId, { phase: 'error', message: String(e.message || e) }))
            .finally(() => { busy = false; });

        sendResponse({ started: true });

        return true;
    }
});
