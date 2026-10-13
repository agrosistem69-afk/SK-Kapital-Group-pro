// Собирает тестовый лист чертежа fixtures/test-sheet.html — вымышленный, без данных реальных проектов.
// Устроен так же, как интерактивные листы проектировщика: ведомость S, план PLANZ (gzip + base64),
// острия выносок TIPS и синяя рамка. Числа подобраны так, чтобы ответы в тестах были известны заранее.
// Запуск: node tests/make-fixture.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = [
    ['Деревья', [['1', 'Клен тестовый', 'шт.', '5']]],
    ['Кустарники', [['2', 'Спирея тестовая', 'шт.', '300']]],
    ['Газоны', [['3', 'Газон рулонный тестовый', 'м²', '120']]],
    ['Мульча', [['4', 'Мульчирование тестовое', 'м²', '10']]],
];

// Синяя рамка: x 5..65, y 5..55 (единица плана — метр).
const frame = '<path class="st" data-s="ctx" stroke="#007fff" d="M5 5l60 0 0 50 -60 0 0-50z"/>';

// Прямоугольник как путь из команд M/l.
const rect = (x, y, w, h) => `M${x} ${y}l${w} 0 0 ${h} ${-w} 0z`;
// Посадка, на которую указывает выноска (data-src="tip").
const item = (s, pos, d, fill) => `<g class="it" data-s="${s}" data-l="Test" data-p="${pos}" data-src="tip"><path fill="${fill}" d="${d}"/></g>`;
// Выноска: подпись-прямоугольник в (lx, ly) и линия к острию (tx, ty).
let h = 0x100;
const callout = (pos, q, lx, ly, tx, ty) => `<g class="it ld" data-s="lbl" data-h="${(h++).toString(16).toUpperCase()}" data-p="${pos}" data-q="${q}"><rect class="hb" x="${lx}" y="${ly}" width="3" height="2"/><path class="ln" stroke="#000" d="M${lx} ${ly}l${+(tx - lx).toFixed(2)} ${+(ty - ly).toFixed(2)}"/></g>`;

const plan = [
    frame,
    // Позиция 1, деревья: 3 шт внутри рамки, 2 шт за рамкой.
    item('tree', '1', rect(19, 19, 2, 2), '#2e7d32'),
    item('tree', '1', rect(79, 19, 2, 2), '#2e7d32'),
    callout('1', '3 шт.', 12, 12, 20, 20),
    callout('1', '2 шт.', 72, 12, 80, 20),
    // Позиция 2, кустарник: полоса 10×10 м = 100 м² внутри (200 шт), полоса 10×10 м за рамкой (100 шт).
    item('bush', '2', rect(25, 28, 10, 10), '#9edee0'),
    item('bush', '2', rect(80, 35, 10, 10), '#9edee0'),
    callout('2', '200 шт.', 18, 24, 30, 30),
    callout('2', '100 шт.', 72, 30, 85, 40),
    // Позиция 3, газон: 80 м² внутри (20×4 м), 40 м² за рамкой.
    item('flow', '3', rect(30, 42, 20, 4), '#c8e6a0'),
    item('flow', '3', rect(85, 5, 10, 4), '#c8e6a0'),
    callout('3', '80 м²', 22, 48, 40, 45),
    callout('3', '40 м²', 75, 2, 90, 7),
    // Позиция 4 (мульча) выносок не имеет.
].join('');

const TIPS = { 1: [[20, 20], [80, 20]], 2: [[30, 30], [85, 40]], 3: [[40, 45], [90, 7]] };
const planz = zlib.gzipSync(Buffer.from(plan, 'utf8')).toString('base64');

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Тестовый лист (вымышленный)</title></head>
<body>
<svg id="plan" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60" preserveAspectRatio="xMidYMid meet"><g id="root"></g></svg>
<script>
const S=${JSON.stringify(S)};
const TIPS=${JSON.stringify(TIPS)};
const PLANZ="${planz}";
(async()=>{const bin=Uint8Array.from(atob(PLANZ),c=>c.charCodeAt(0));
document.getElementById("root").innerHTML=await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))).text();})();
</script>
</body></html>
`;
fs.writeFileSync(path.join(__dirname, 'fixtures', 'test-sheet.html'), html);
console.log('fixtures/test-sheet.html готов');
