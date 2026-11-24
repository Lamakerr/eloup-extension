<?php

/*
 * Сборка пакета расширения ELOUP для Chrome Web Store.
 *
 * В пакет попадают только рабочие файлы — список берётся из манифеста
 * (фоновый воркер, контент-скрипты, попап, иконки) и из ссылок страниц
 * расширения на свои скрипты и стили. Если в репозитории остался рабочий
 * файл вне этого списка — сборка останавливается: ничего не забыть.
 * README и PHP-скрипты репозитория в магазин не едут. Манифест очищается
 * от прав на localhost и 127.0.0.1 — они нужны только для отладки из папки
 * репозитория, в магазине расширение работает лишь с eloup.gg.
 *
 * Запуск из корня расширения: php build.php
 * Итог: dist/eloup-extension-<версия>.zip
 */

declare(strict_types=1);

/** Останавливает сборку с сообщением об ошибке. */
function fail(string $message): never
{
    fwrite(STDERR, "ОШИБКА: {$message}\n");

    exit(1);
}

$root = __DIR__;
$dist = $root.DIRECTORY_SEPARATOR.'dist';

$raw = file_get_contents($root.'/manifest.json');

if ($raw === false) {
    fail('manifest.json не читается');
}

try {
    $manifest = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    fail("манифест не является корректным JSON: {$e->getMessage()}");
}

if (! is_array($manifest)) {
    fail('манифест должен быть JSON-объектом');
}

// ---- Проверки полей, которые магазин проверяет сам ---------------------------

$length = static function (string $text): int {
    return function_exists('mb_strlen') ? mb_strlen($text) : strlen($text);
};

foreach (['name', 'version', 'description', 'icons'] as $key) {
    if (! isset($manifest[$key])) {
        fail("в манифесте нет поля «{$key}»");
    }
}

if ($length((string) $manifest['name']) > 75) {
    fail('name длиннее 75 символов');
}

if ($length((string) $manifest['description']) > 132) {
    fail('description длиннее 132 символов');
}

if (! preg_match('/^\d{1,5}(\.\d{1,5}){0,3}$/', (string) $manifest['version'])) {
    fail('version должна быть от одной до четырёх групп цифр, например 0.3.5');
}

// ---- Манифест для магазина ----------------------------------------------------

// Локальные адреса — только для отладки: в пакете расширение говорит лишь с eloup.gg
$local = static fn (string $host): bool => (bool) preg_match('#^[a-z][a-z0-9+.-]*://(localhost|127\.0\.0\.1)(/|$)#i', $host);

$manifest['host_permissions'] = array_values(array_filter($manifest['host_permissions'] ?? [], static fn (string $host): bool => ! $local($host)));

$packedManifest = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

if ($packedManifest === false) {
    fail('манифест не кодируется обратно в JSON');
}

$packedManifest .= "\n";

// ---- Файлы пакета — строго из манифеста ---------------------------------------

$files = [
    $manifest['background']['service_worker'] ?? null,
    $manifest['action']['default_popup'] ?? null,
    ...array_values($manifest['icons'] ?? []),
    ...array_values($manifest['action']['default_icon'] ?? []),
];

foreach ($manifest['content_scripts'] ?? [] as $script) {
    foreach ($script['js'] ?? [] as $file) {
        $files[] = $file;
    }
}

// Страницы расширения (попап) подключают свои скрипты и стили тегами —
// в манифесте их нет, читаем из самого HTML
$pages = array_values(array_filter([
    $manifest['action']['default_popup'] ?? null,
    $manifest['options_page'] ?? null,
    $manifest['options_ui']['page'] ?? null,
]));

foreach ($pages as $page) {
    $html = (string) file_get_contents($root.'/'.$page);

    if (preg_match_all('/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["\']([^"\'#?]+)["\']/i', $html, $assets)) {
        array_push($files, ...$assets[1]);
    }
}

$files = array_values(array_unique(array_filter($files)));

foreach ($files as $file) {
    if (! is_string($file) || str_contains($file, '..') || str_starts_with($file, '/')) {
        fail('в манифесте недопустимый путь к файлу');
    }

    if (! is_file($root.'/'.$file) || ! is_readable($root.'/'.$file)) {
        fail("нет файла «{$file}», на который ссылается манифест");
    }
}

// Ничего не забыли: в репозитории не должно остаться рабочих файлов вне пакета.
// Служебное — README, PHP-скрипты, .gitignore и папка dist — в магазин не едет
$inPackage = array_fill_keys(['manifest.json', ...$files], true);
$skip = static fn (SplFileInfo $current): bool => ! in_array($current->getFilename(), ['.git', 'dist'], true);

$tree = new RecursiveIteratorIterator(new RecursiveCallbackFilterIterator(
    new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
    $skip
));

foreach ($tree as $entry) {
    $relative = str_replace('\\', '/', substr($entry->getPathname(), strlen($root) + 1));

    if (! $entry->isFile() || isset($inPackage[$relative]) || preg_match('/\.(php|md)$/i', $relative) || $relative === '.gitignore') {
        continue;
    }

    fail("файл «{$relative}» есть в репозитории, но не попал в пакет — подключите его или добавьте к служебным в build.php");
}

// ---- Сборка ----------------------------------------------------------------------

if (! is_dir($dist) && ! mkdir($dist, 0777, true) && ! is_dir($dist)) {
    fail('не создаётся папка dist');
}

$zipPath = $dist.'/eloup-extension-'.$manifest['version'].'.zip';
$zip = new ZipArchive;

if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
    fail("не открывается на запись: {$zipPath}");
}

$zip->addFromString('manifest.json', $packedManifest);
$zip->setCompressionName('manifest.json', ZipArchive::CM_DEFLATE);

// Штамп времени — как у файла в репозитории: повторная сборка того же дерева
// даёт байт в байт тот же архив
$zip->setMtimeName('manifest.json', (int) filemtime($root.'/manifest.json'), ZipArchive::FL_OVERWRITE);

foreach ($files as $file) {
    $zip->addFile($root.'/'.$file, $file);
    $zip->setCompressionName($file, ZipArchive::CM_DEFLATE);
}

if (! $zip->close()) {
    fail('архив не собрался');
}

// ---- Перечитываем готовый архив ---------------------------------------------------

$check = new ZipArchive;

if ($check->open($zipPath, ZipArchive::CHECKCONS) !== true) {
    fail('собранный архив не открывается или повреждён');
}

$packed = [];

for ($i = 0; $i < $check->numFiles; $i++) {
    $stat = $check->statIndex($i);
    $packed[$stat['name']] = $stat['size'];
}

if (array_keys($packed) !== ['manifest.json', ...$files]) {
    fail('состав архива не совпал с ожидаемым: '.implode(', ', array_keys($packed)));
}

foreach ($packed as $name => $size) {
    if (preg_match('/\.(php|md)$/i', $name) || $size === 0) {
        fail("в архиве проблемный файл «{$name}»");
    }
}

$packedJson = json_decode((string) $check->getFromName('manifest.json'), true);

if (! is_array($packedJson)) {
    fail('манифест внутри архива не читается');
}

foreach ($packedJson['host_permissions'] ?? [] as $host) {
    if ($local((string) $host)) {
        fail("в архиве осталось право на локальный адрес: {$host}");
    }
}

// Содержимое архива — байт в байт то, что лежит в репозитории
foreach ($files as $file) {
    if ($check->getFromName($file) !== file_get_contents($root.'/'.$file)) {
        fail("файл «{$file}» в архиве отличается от репозитория");
    }
}

$check->close();

// Манифест в архиве должен в точности равняться манифесту репозитория без
// прав на локальные адреса — больше сборка в нём ничего не меняет. Сверяем
// не текст (отступы и окончания строк не в счёт), а сами данные — как их
// читает Chrome
$changed = [];

foreach ($manifest as $key => $value) {
    if (($packedJson[$key] ?? null) !== $value) {
        $changed[] = $key;
    }
}

foreach ($packedJson as $key => $value) {
    if (! array_key_exists($key, $manifest)) {
        $changed[] = $key;
    }
}

if ($changed !== []) {
    fwrite(STDERR, 'ВНИМАНИЕ: манифест в пакете отличается от репозитория не только правами на локальные адреса — сверьте вручную: '.implode(', ', array_unique($changed)).PHP_EOL);
}

// ---- Итог --------------------------------------------------------------------------

fwrite(STDOUT, "Пакет: {$zipPath}\n");

foreach ($packed as $name => $size) {
    fwrite(STDOUT, sprintf("  %-18s %7d байт\n", $name, $size));
}

fwrite(STDOUT, sprintf(
    "Итого: %d файлов, %s байт\n",
    count($packed),
    number_format((int) filesize($zipPath), 0, '', ' ')
));
fwrite(STDOUT, 'permissions: '.implode(', ', $manifest['permissions'] ?? [])."\n");
fwrite(STDOUT, 'host_permissions: '.implode(', ', $manifest['host_permissions'])."\n");
fwrite(STDOUT, 'SHA-256: '.hash_file('sha256', $zipPath)."\n");
