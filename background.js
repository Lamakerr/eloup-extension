// Фоновый воркер расширения ELOUP (#258, #288): транспортный агент.
// Подписанную ссылку на демку добывает контент-скрипт на странице FACEIT —
// там живёт сессия игрока (демки — приватный ресурс, серверу ELOUP они
// недоступны). Фон только передаёт файл на eloup.gg кусками, не сохраняя
// его на диск целиком: fetch → буфер 16 МиБ → POST.

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

// Статусы матчей батчем — для кнопок в истории матчей: сервер принимает
// до 20 идентификаторов за запрос
async function getStates(matchIds) {
    const ids = (matchIds || []).slice(0, 20).map(encodeURIComponent).join(',');
    const { json, response } = await api(`/api/extension/state?match_ids=${ids}`);

    if (response.status === 401) {
        return { auth: false };
    }

    if (!response.ok) {
        return { auth: true, error: json.error || `ELOUP ответил ${response.status}` };
    }

    return { auth: true, matches: json.matches || [] };
}

// Публичные профили ELOUP по никам десятки — для бейджей в комнате матча
async function lookupPlayers(nicknames) {
    const { json, response } = await api('/api/extension/players/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nicknames: (nicknames || []).slice(0, 10) }),
    });

    if (response.status === 401) {
        return { auth: false };
    }

    if (!response.ok) {
        return { auth: true, error: json.error || `ELOUP ответил ${response.status}` };
    }

    return { auth: true, players: json.players || [] };
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

async function transfer(matchId, tabId, link, focusNickname) {
    // Прогресс уходит с идентификатором матча: в истории матчей по нему
    // находится строка, в комнате — кнопка
    const notify = (state) => report(tabId, { ...state, matchId });

    const state = await getState(matchId);

    if (!state.auth) {
        throw new Error('Нет токена ELOUP — создайте его в настройках профиля, вкладка «Катки»');
    }

    if (state.error) {
        throw new Error(state.error);
    }

    if (state.known) {
        // Матч уже на ELOUP — открываем готовый разбор
        notify({ phase: 'done', url: state.known.url });

        return;
    }

    notify({ phase: 'download', percent: 0 });

    // Подписанный URL публичный (S3 + подпись в query) — куки FACEIT не нужны
    const response = await fetch(link);

    if (!response.ok || !response.body) {
        throw new Error(`CDN FACEIT не отдал демку (${response.status}) — ссылка живёт 5 минут, нажмите кнопку ещё раз`);
    }

    const total = Number(response.headers.get('content-length')) || 0;

    if (!total) {
        // total_size — это Content-Length: сервер по нему узнаёт, что файл
        // доехал целиком (без него первый же чанк «закрыл» бы передачу)
        throw new Error('CDN FACEIT не отдал размер демки — сообщите в ELOUP');
    }

    const chunkSize = Math.min(state.upload?.chunk_size || 16 * 1024 * 1024, 32 * 1024 * 1024);
    const maxBytes = state.upload?.max_bytes || 1024 * 1024 * 1024;

    const uploadId = crypto.randomUUID();
    const reader = response.body.getReader();

    let received = 0;
    let offset = 0;

    // Один чанк из сети: буфер наполняется до границы chunkSize, на конце
    // потока возвращается last=true
    const fill = async () => {
        const buffer = new Uint8Array(chunkSize);
        let filled = 0;

        while (filled < chunkSize) {
            const { done, value } = await reader.read();

            if (done) {
                return { buffer, filled, last: true };
            }

            if (received + value.length > maxBytes) {
                throw new Error('Демка больше лимита ELOUP');
            }

            received += value.length;

            notify({ phase: 'download', percent: Math.round((received / total) * 100) });

            let cursor = 0;

            while (cursor < value.length) {
                const take = Math.min(chunkSize - filled, value.length - cursor);

                buffer.set(value.subarray(cursor, cursor + take), filled);
                filled += take;
                cursor += take;

                if (filled === chunkSize) {
                    return { buffer, filled, last: false };
                }
            }
        }
    };

    const flush = async (buffer, filled) => {
        const form = new FormData();

        form.append('match_id', matchId);
        form.append('upload_id', uploadId);
        form.append('offset', String(offset));
        // Полный размер файла, а не сколько скачано: сервер закрывает передачу,
        // когда сумма кусков доходит до него
        form.append('total_size', String(total));
        // Ник FACEIT из комнаты — фокус разбора (см. myMatchNickname в content.js)
        if (focusNickname) {
            form.append('focus_nickname', focusNickname);
        }
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

        return json;
    };

    // Конвейер: пока чанк едет на ELOUP, сеть уже читает следующий — TTL
    // подписи FACEIT (299 с) тратится на работу, а не на простой сети
    let send = Promise.resolve({ done: false });

    while (true) {
        const chunk = await fill();

        // POST'ы идут строго по порядку смещений — ждём предыдущий
        await send;

        if (chunk.filled > 0) {
            send = flush(chunk.buffer, chunk.filled);

            notify({ phase: 'upload', percent: Math.round(((offset + chunk.filled) / total) * 100) });
        }

        if (chunk.last) {
            break;
        }
    }

    const result = await send;

    if (result.done) {
        notify({ phase: 'done', url: result.url });

        return;
    }

    // Сервер не закрыл передачу (например, файл лёг ровно в границу куска,
    // а хвостового чанка не было) — сверяемся по состоянию матча
    const check = await getState(matchId);

    if (check.known) {
        notify({ phase: 'done', url: check.known.url });

        return;
    }

    throw new Error('Передача оборвалась — нажмите кнопку ещё раз');
}

// ---- Шина сообщений -------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'eloup-check') {
        getState(message.matchId).then(sendResponse);

        return true;
    }

    if (message?.type === 'eloup-check-many') {
        getStates(message.matchIds).then(sendResponse);

        return true;
    }

    if (message?.type === 'eloup-lookup') {
        lookupPlayers(message.nicknames).then(sendResponse);

        return true;
    }

    if (message?.type === 'eloup-analyze') {
        if (busy) {
            sendResponse({ error: 'Демка уже передаётся — дождитесь её' });

            return true;
        }

        busy = true;
        const tabId = sender?.tab?.id ?? null;

        transfer(message.matchId, tabId, message.downloadUrl, message.focusNickname || null)
            .catch(async (e) => {
                // Сдвиг куска: один рестарт с чистым идентификатором и свежей
                // подписью FACEIT, дальше — ошибка
                if (e.restart) {
                    return transfer(message.matchId, tabId, await resign(tabId, message.matchId), message.focusNickname || null);
                }

                throw e;
            })
            .catch((e) => report(tabId, { phase: 'error', message: String(e.message || e), matchId: message.matchId }))
            .finally(() => { busy = false; });

        sendResponse({ started: true });

        return true;
    }
});
