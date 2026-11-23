<?php

/*
 * Сборка иконок расширения ELOUP из фирменного знака — геометрия public/favicon.svg:
 * круглая плитка #0f0f10, ломаная роста с вертикальным градиентом
 * #e8ff66 → #ccff00 → #a3d100 и тёмной подложкой #3a4a00.
 * Суперсэмплинг 8x + imagecopyresampled дают сглаживание без антиалиасинга GD.
 * Запуск из корня расширения: php icons/build.php
 */

declare(strict_types=1);

const SIZES = [16, 48, 128];
const SS = 8; // фактор суперсэмплинга

// Локальные координаты знака (до translate/scale из favicon.svg)
const NODES = [[9.0, 60.5], [42.5, 38.0], [66.5, 49.5], [95.5, 11.0]];
const NODE_R = [7.0, 7.0, 7.0, 7.5];
const STROKE = 7.5;
const OFFSET = [10.5, 23.0];
const SCALE = 0.75;
const SHADOW_DY = 2.2;

// Вертикальный градиент: [локальный Y, [r, g, b]]
const GRADIENT = [
    [3.0, [0xe8, 0xff, 0x66]],
    [38.75, [0xcc, 0xff, 0x00]],
    [68.0, [0xa3, 0xd1, 0x00]],
];

/** Цвет градиента в точке локального Y знака. */
function gradientAt(float $y): array
{
    if ($y <= GRADIENT[0][0]) {
        return GRADIENT[0][1];
    }
    foreach (GRADIENT as $i => $stop) {
        if ($i === 0) {
            continue;
        }
        [$y2, $c2] = $stop;
        [$y1, $c1] = GRADIENT[$i - 1];
        if ($y <= $y2) {
            $t = ($y - $y1) / ($y2 - $y1);

            return [
                (int) round($c1[0] + ($c2[0] - $c1[0]) * $t),
                (int) round($c1[1] + ($c2[1] - $c1[1]) * $t),
                (int) round($c1[2] + ($c2[2] - $c1[2]) * $t),
            ];
        }
    }

    return GRADIENT[count(GRADIENT) - 1][1];
}

/** Локальные координаты знака → пиксели суперсэмпла. */
function toPixels(float $lx, float $ly, int $w, float $dy): array
{
    return [
        ($lx * SCALE + OFFSET[0]) / 100 * $w,
        ($ly * SCALE + OFFSET[1] + $dy) / 100 * $w,
    ];
}

/** Пиксель суперсэмпла → локальный Y знака (для цвета градиента). */
function toLocalY(float $py, int $w, float $dy): float
{
    return ($py / $w * 100 - OFFSET[1] - $dy) / SCALE;
}

/** Ломаная с узлами; $flat — цвет плоской подложки, иначе градиент. */
function drawGraph($img, int $w, float $dy, ?array $flat): void
{
    // Сегменты ломаной короткими отрезками — цвет градиента по Y середины.
    imagesetthickness($img, (int) round(STROKE * SCALE / 100 * $w));
    for ($i = 0; $i < count(NODES) - 1; $i++) {
        [$x1, $y1] = toPixels(NODES[$i][0], NODES[$i][1], $w, $dy);
        [$x2, $y2] = toPixels(NODES[$i + 1][0], NODES[$i + 1][1], $w, $dy);
        $steps = max(1, (int) ceil(hypot($x2 - $x1, $y2 - $y1) * 2));
        for ($s = 1; $s <= $steps; $s++) {
            $t = $s / $steps;
            $px = $x1 + ($x2 - $x1) * $t;
            $py = $y1 + ($y2 - $y1) * $t;
            $c = $flat ?? gradientAt(toLocalY($py, $w, $dy));
            imageline($img, (int) round($x1 + ($x2 - $x1) * ($s - 1) / $steps),
                (int) round($y1 + ($y2 - $y1) * ($s - 1) / $steps),
                (int) round($px), (int) round($py),
                imagecolorallocate($img, $c[0], $c[1], $c[2]));
        }
    }

    // Узлы — горизонтальными полосками по 1 px (цвет градиента по Y полоски).
    foreach (NODES as $i => $node) {
        [$cx, $cy] = toPixels($node[0], $node[1], $w, $dy);
        $r = NODE_R[$i] * SCALE / 100 * $w;
        for ($yy = -$r; $yy < $r; $yy += 1) {
            $yc = $yy + 0.5;
            $half = sqrt(max(0, $r * $r - $yc * $yc));
            if ($half <= 0) {
                continue;
            }
            $c = $flat ?? gradientAt(toLocalY($cy + $yy, $w, $dy));
            imagefilledrectangle($img, (int) round($cx - $half), (int) round($cy + $yy),
                (int) round($cx + $half), (int) round($cy + $yy + 1),
                imagecolorallocate($img, $c[0], $c[1], $c[2]));
        }
    }
}

foreach (SIZES as $size) {
    $w = $size * SS;
    $img = imagecreatetruecolor($w, $w);
    imagesavealpha($img, true);
    $transparent = imagecolorallocatealpha($img, 0, 0, 0, 127);
    imagefill($img, 0, 0, $transparent);

    // Круглая плитка фона (#0f0f10), как у favicon сайта.
    imagefilledellipse($img, (int) ($w / 2), (int) ($w / 2), $w, $w,
        imagecolorallocate($img, 0x0f, 0x0f, 0x10));

    // Тёмная подложка-тень — с 48 px; на 16 она превращается в грязь.
    if ($size > 24) {
        drawGraph($img, $w, SHADOW_DY, [0x3a, 0x4a, 0x00]);
    }
    drawGraph($img, $w, 0, null);

    $out = imagecreatetruecolor($size, $size);
    imagesavealpha($out, true);
    imagefill($out, 0, 0, $transparent);
    imagecopyresampled($out, $img, 0, 0, 0, 0, $size, $size, $w, $w);

    $file = __DIR__."/icon-$size.png";
    imagepng($out, $file, 9);
    imagedestroy($img);
    imagedestroy($out);
    echo "$file — ".round(filesize($file) / 1024, 1)." КБ\n";
}
