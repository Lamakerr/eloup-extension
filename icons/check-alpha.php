<?php

// Разовая проверка прозрачности углов иконок (после build.php).
$d = __DIR__.'/';
foreach ([16, 48, 128] as $s) {
    $i = imagecreatefrompng($d."icon-$s.png");
    $alpha = fn ($x, $y) => (imagecolorat($i, $x, $y) & 0x7F000000) >> 24;
    printf("%d px: углы %d/%d/%d/%d (127 = прозрачный), центр alpha=%d\n",
        $s, $alpha(0, 0), $alpha($s - 1, 0), $alpha(0, $s - 1), $alpha($s - 1, $s - 1),
        $alpha((int) ($s / 2), (int) ($s / 2)));
}
