// Автотесты SKKG Pro. Робот открывает приложение в браузере (Chromium), нажимает кнопки и сверяет результат
// с заранее известными числами. Вместо настоящей базы — подменная в памяти (fake-supabase.js),
// вместо настоящего чертежа — вымышленный лист fixtures/test-sheet.html.
//
// Запуск: cd tests && npm install && node run.js
// Итог печатается по-русски; в GitHub Actions он же попадает в отчёт (Summary) запуска.
// Если хоть одна проверка не прошла, программа завершается с ошибкой — и публикация не начнётся.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const SHEET_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-sheet.html'), 'utf8');
const FAKE_SUPABASE = fs.readFileSync(path.join(__dirname, 'fake-supabase.js'), 'utf8');
const XLSX_JS = fs.readFileSync(require.resolve('xlsx/dist/xlsx.full.min.js'), 'utf8');

// Стили Tailwind собираем заранее из index.html, чтобы тестам не нужен был интернет.
function buildCss() {
    const out = path.join(__dirname, '.tailwind.css');
    const input = path.join(__dirname, '.tailwind-in.css');
    fs.writeFileSync(input, '@tailwind base;@tailwind components;@tailwind utilities;');
    execFileSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-c', path.join(__dirname, 'tailwind.config.js'), '-i', input, '-o', out], { stdio: 'ignore' });
    return fs.readFileSync(out, 'utf8');
}

// Простой сервер, раздающий файлы приложения.
function startServer() {
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
    const server = http.createServer((req, res) => {
        let p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
        if (p.startsWith(ROOT) && fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
        if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
        fs.createReadStream(p).pipe(res);
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

let browser, baseUrl, css;

// Открыть приложение под заданной ролью. admin — может ли пользователь загружать чертежи и менять проектные объёмы.
async function openApp({ role = 'manager', admin = false, width = 1280, height = 800 } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message));
    // Всё внешнее отключаем; нужные библиотеки подставляем локально (последнее правило главнее).
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.fulfill({ status: 200, body: '' }));
    await page.route(/supabase-js/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
    await page.route(/cdn\.tailwindcss\.com/, r => r.fulfill({ contentType: 'application/javascript', body: `window.tailwind={};var s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);` }));
    // Служебный обработчик (service worker) в тестах пустой, чтобы он не кэшировал файлы между проверками.
    await page.route(/service-worker\.js/, r => r.fulfill({ contentType: 'application/javascript', body: 'self.addEventListener("install", () => self.skipWaiting());' }));
    await page.route(/xlsx[^/]*\.js/, r => r.fulfill({ contentType: 'application/javascript', body: XLSX_JS }));
    await page.goto(baseUrl + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof applyRoleUI === 'function' && window.__db);
    await page.evaluate(async ({ role, admin, html }) => {
        __db.projects.push({ id: 'p1', name: 'Тестовый проект' });
        __db.drawings.push({ id: 'd1', project_id: 'p1', sheet: 'Лист 1 тестовый посадочный план', section: 'Озеленение', file_path: 'p1/test-sheet.html', revision_date: '2026-10-01', updated_at: '2026-10-01T10:00:00Z' });
        __files['p1/test-sheet.html'] = html;
        __rpc.can_manage_drawings = admin;
        ['authCheckingScreen', 'loginScreen'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
        document.getElementById('appRoot')?.classList.remove('hidden');
        currentUserRole = role;
        appData.projects = [{ id: 'p1', name: 'Тестовый проект' }];
        applyRoleUI(role);
        await loadDrawingsAdminFlag();
        showBoardsScreen();
    }, { role, admin, html: SHEET_HTML });
    return page;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function expect(cond, message) { if (!cond) throw new Error(message); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const visible = (page, sel) => page.$eval(sel, el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden').catch(() => false);
const materialsByName = page => page.evaluate(() => Object.fromEntries(__db.materials.map(m => [m.name, m.design_qty])));

// Открыть «Объёмы» и загрузить проектные объёмы из тестового листа (как кнопка «Из чертежей» → «Обновить объёмы»).
async function importFromDrawings(page, { onlyInFrame = true } = {}) {
    await page.evaluate(() => importVolumesFromDrawings());
    await page.waitForFunction(() => document.getElementById('fromDrawingsSaveBtn'), null, { timeout: 15000 });
    if (!onlyInFrame) await page.evaluate(() => { pendingImport.drawingSheets.forEach(s => { s.onlyInFrame = false; }); renderDrawingImportPreview(); });
    await page.evaluate(() => saveVolumesFromDrawings());
    await page.waitForFunction(() => document.getElementById('volumesModal').classList.contains('hidden'), null, { timeout: 15000 });
}

// Точка плана (в метрах) → точка на экране.
const planToScreen = (page, x, y) => page.evaluate(([x, y]) => {
    const svg = document.getElementById('zonesSvg'), pt = svg.createSVGPoint();
    pt.x = x; pt.y = y;
    const r = pt.matrixTransform(svg.getScreenCTM());
    return [r.x, r.y];
}, [x, y]);
async function openZones(page) {
    await page.evaluate(() => showVolumesScreen());
    await page.click('text=По зонам');
    await page.waitForFunction(() => zonesState?.plan && zonesState.parcels.size, null, { timeout: 15000 });
}
async function drawZone(page, pts) {
    // Отдаляем план, чтобы углы зоны не попали под кнопки поверх плана.
    await page.evaluate(() => { zonesFit(); zonesZoomButton(2); });
    await page.click('#zonesToolbar >> text=Новая зона');
    for (const [x, y] of pts) { const [sx, sy] = await planToScreen(page, x, y); await page.mouse.click(sx, sy); }
    await page.click('#zonesToolbar >> text=Готово');
}

// ================= ПРОВЕРКИ =================

test('Приложение открывается без ошибок', async () => {
    const page = await openApp();
    expect(await visible(page, '#boardsScreen'), 'не видно экрана «Проекты»');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Нижнее меню: Проекты, Чертежи, Объёмы, Ещё, Аккаунт', async () => {
    const page = await openApp();
    const nav = await page.$eval('nav', n => [...n.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => b.innerText.trim()));
    for (const t of ['Проекты', 'Чертежи', 'Объёмы', 'Ещё', 'Аккаунт']) expect(nav.includes(t), `в меню нет «${t}» (есть: ${nav.join(', ')})`);
    expect(!nav.includes('Бухгалтерия') && !nav.includes('ПТО'), 'Бухгалтерия и ПТО должны быть в «Ещё», а не в нижнем меню');
    await page.evaluate(() => openModal('mobileMenuModal'));
    const more = await page.$eval('#mobileMenuModal', m => m.innerText);
    expect(more.includes('Бухгалтерия') && more.includes('ПТО') && more.includes('План-график'), 'в меню «Ещё» нет Бухгалтерии, ПТО или План-графика');
});

test('Роли: бухгалтер загружает документы 1С, ПТО — нет', async () => {
    const acc = await openApp({ role: 'accountant' });
    await acc.evaluate(() => showVolumesScreen());
    expect(await visible(acc, 'button:has-text("Загрузить документ 1С")'), 'бухгалтер не видит «Загрузить документ 1С»');
    const pto = await openApp({ role: 'pto' });
    await pto.evaluate(() => showVolumesScreen());
    expect(!(await visible(pto, 'button:has-text("Загрузить документ 1С")')), 'ПТО видит «Загрузить документ 1С», а не должен');
});

test('«Из чертежей» видно только тому, кто отвечает за чертежи', async () => {
    const admin = await openApp({ admin: true });
    await admin.evaluate(() => showVolumesScreen());
    expect(await visible(admin, 'button:has-text("Из чертежей")'), 'ответственный за чертежи не видит «Из чертежей»');
    const other = await openApp({ admin: false });
    await other.evaluate(() => showVolumesScreen());
    expect(!(await visible(other, 'button:has-text("Из чертежей")')), 'кнопку «Из чертежей» видит не ответственный');
});

test('Ведомость материалов читается из чертежа', async () => {
    const page = await openApp();
    const rows = await page.evaluate(html => extractDrawingQuantities(html).map(r => [r.pos, r.name, r.unit, r.qty]), SHEET_HTML);
    expect(rows.length === 4, `ожидалось 4 позиции, прочитано ${rows.length}`);
    const qty = Object.fromEntries(rows.map(r => [r[0], r[3]]));
    expect(qty[1] === 5 && qty[2] === 300 && qty[3] === 120 && qty[4] === 10, 'неверные количества: ' + JSON.stringify(qty));
});

test('Синяя рамка: найдено, что за рамкой', async () => {
    const page = await openApp();
    const fr = await page.evaluate(html => drawingFrameExclusions(html), SHEET_HTML);
    expect(fr && fr.hasFrame, 'рамка не найдена');
    expect(fr.outside[1] === 2 && fr.outside[2] === 100 && fr.outside[3] === 40, 'за рамкой ожидалось 2 шт, 100 шт, 40 м², получено ' + JSON.stringify(fr.outside));
});

test('«Из чертежей»: в объёмы идёт только то, что внутри рамки', async () => {
    const page = await openApp({ admin: true });
    await page.evaluate(() => showVolumesScreen());
    await importFromDrawings(page);
    const m = await materialsByName(page);
    expect(m['Клен тестовый'] === 3, 'клен: ожидалось 3, получено ' + m['Клен тестовый']);
    expect(m['Спирея тестовая'] === 200, 'спирея: ожидалось 200, получено ' + m['Спирея тестовая']);
    expect(m['Газон рулонный тестовый'] === 80, 'газон: ожидалось 80, получено ' + m['Газон рулонный тестовый']);
    expect(m['Мульчирование тестовое'] === 10, 'мульча без выносок должна остаться 10, получено ' + m['Мульчирование тестовое']);
});

test('Повторное «Обновить объёмы» не создаёт дублей', async () => {
    const page = await openApp({ admin: true });
    await page.evaluate(() => showVolumesScreen());
    await importFromDrawings(page);
    await importFromDrawings(page);
    const n = await page.evaluate(() => __db.materials.length);
    expect(n === 4, `ожидалось 4 материала, стало ${n}`);
});

test('Без галочки «только внутри рамки» — полные объёмы', async () => {
    const page = await openApp({ admin: true });
    await page.evaluate(() => showVolumesScreen());
    await importFromDrawings(page, { onlyInFrame: false });
    const m = await materialsByName(page);
    expect(m['Клен тестовый'] === 5 && m['Спирея тестовая'] === 300 && m['Газон рулонный тестовый'] === 120, 'ожидалось 5 / 300 / 120, получено ' + JSON.stringify(m));
});

test('Поставка вручную уменьшает «Осталось»', async () => {
    const page = await openApp({ admin: true });
    await page.evaluate(() => showVolumesScreen());
    await importFromDrawings(page);
    await page.evaluate(() => openDeliveryForm());
    const spirea = await page.evaluate(() => __db.materials.find(m => m.name === 'Спирея тестовая').id);
    await page.selectOption('#delMat', spirea);
    await page.fill('#delQty', '50');
    await page.evaluate(() => saveManualDelivery(new Event('submit')));
    await page.waitForFunction(() => document.getElementById('volumesModal').classList.contains('hidden'), null, { timeout: 10000 });
    const t = await page.evaluate(id => materialTotals(id), spirea);
    expect(t.design === 200 && t.delivered === 50 && t.left === 150, 'ожидалось 200 / 50 / 150, получено ' + JSON.stringify(t));
});

test('Документ 1С (Excel): строки сами находят свой материал', async () => {
    const page = await openApp({ admin: true });
    await page.evaluate(() => showVolumesScreen());
    await importFromDrawings(page);
    const ws = XLSX.utils.aoa_to_sheet([
        ['Товарная накладная № 15 от 05.10.2026'], [],
        ['№', 'Наименование', 'Ед.', 'Количество'],
        [1, 'Спирея тестовая', 'шт', 30],
        [2, 'Газон рулонный тестовый', 'м2', 20],
    ]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Лист1');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    await page.setInputFiles('#deliveryImportFile', { name: 'nakladnaya.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await page.waitForSelector('#volumesModal >> text=Сохранить строки', { timeout: 15000 });
    await page.click('#volumesModal >> text=Сохранить строки');
    await page.waitForFunction(() => __db.material_deliveries.length === 2, null, { timeout: 10000 });
    const d = await page.evaluate(() => __db.material_deliveries.map(x => [__db.materials.find(m => m.id === x.material_id)?.name || 'без материала', x.qty]));
    expect(JSON.stringify(d) === JSON.stringify([['Спирея тестовая', 30], ['Газон рулонный тестовый', 20]]), 'строки разнесены неверно: ' + JSON.stringify(d));
});

test('Документ УПД из 1С (XML) читается', async () => {
    const page = await openApp({ admin: true });
    await page.evaluate(() => showVolumesScreen());
    await importFromDrawings(page);
    const xml = `<?xml version="1.0" encoding="utf-8"?><Файл><Документ><СвСчФакт НомерСчФ="77" ДатаСчФ="06.10.2026"><СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО Тестовый питомник"/></ИдСв></СвПрод></СвСчФакт><ТаблСчФакт><СведТов НаимТов="Спирея тестовая" КолТов="12" НаимЕдИзм="шт"/></ТаблСчФакт></Документ></Файл>`;
    await page.setInputFiles('#deliveryImportFile', { name: 'upd.xml', mimeType: 'application/xml', buffer: Buffer.from(xml, 'utf8') });
    await page.waitForSelector('#volumesModal >> text=Сохранить строки', { timeout: 15000 });
    await page.click('#volumesModal >> text=Сохранить строки');
    await page.waitForFunction(() => __db.material_deliveries.length === 1, null, { timeout: 10000 });
    const d = await page.evaluate(() => __db.material_deliveries[0]);
    expect(d.qty === 12 && d.doc_number === '77' && d.supplier === 'ООО Тестовый питомник', 'прочитано неверно: ' + JSON.stringify(d));
});

test('По зонам: выбор участка нажатием — количество и площадь', async () => {
    const page = await openApp();
    await openZones(page);
    const [sx, sy] = await planToScreen(page, 30, 34);   // середина полосы спиреи внутри рамки
    await page.mouse.click(sx, sy);
    const rows = await page.evaluate(() => zonesPickedRows().map(r => ({ pos: r.pos, qty: r.qty, area: r.area })));
    expect(rows.length === 1 && rows[0].pos === '2' && rows[0].qty === 200, 'ожидалась спирея 200 шт, выбрано ' + JSON.stringify(rows));
    expect(near(rows[0].area, 100, 2), 'площадь полосы 10×10 м должна быть около 100 м², получено ' + rows[0].area);
    await page.mouse.click(sx, sy);
    expect(await page.evaluate(() => zonesState.picked.size) === 0, 'повторное нажатие не сняло выбор');
});

test('По зонам: обведённая зона — площадь и количество', async () => {
    const page = await openApp();
    await openZones(page);
    await page.click('#zonesToolbar >> text=Обвести зону');
    await drawZone(page, [[0, 0], [50, 0], [50, 60], [0, 60]]);
    let r = await page.evaluate(() => zonesCompute());
    expect(r.areas[0] === 3000, 'площадь зоны 50×60 м должна быть 3000 м², получено ' + r.areas[0]);
    const q = Object.fromEntries(r.rows.map(x => [x.pos, x.total]));
    expect(q[1] === 3 && q[2] === 200 && q[3] === 80, 'в зоне ожидалось 3 / 200 / 80, получено ' + JSON.stringify(q));
    await drawZone(page, [[40, 0], [100, 0], [100, 60], [40, 60]]);
    r = await page.evaluate(() => zonesCompute());
    expect(r.overlap && near(r.areaTotal, 6000, 60), 'зоны пересекаются: общая площадь должна быть около 6000 м², получено ' + r.areaTotal);
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('По зонам: участок без выноски найден, подсвечен и считается', async () => {
    const page = await openApp();
    await openZones(page);
    const o = await page.evaluate(() => zonesState.orphans.map(p => ({ pos: p.pos, area: p.area, qty: p.qty })));
    expect(o.length === 1, 'ожидался 1 участок без выноски (подложка под подписанным газоном не считается), найдено ' + JSON.stringify(o));
    expect(o[0].pos === '3' && near(o[0].area, 50, 1.5) && near(o[0].qty, 50, 1.5), 'участок 10×5 м: ожидался газон (поз. 3), 50 м², получено ' + JSON.stringify(o[0]));
    expect((await page.$eval('#zonesOrphans', e => e.innerText)).includes('Участки без выноски: 1'), 'нет списка участков без выноски');
    expect(await page.$$eval('#zonesPlan g.zorphan', g => g.length) === 1, 'участок без выноски не подсвечен на плане');
    // Кусок газона, который уже посчитан в выноске соседа (40 м² на две фигуры по 20 м²), — не «без выноски»:
    // нажатие на него выбирает участок той выноски.
    const [px, py] = await planToScreen(page, 90, 8);
    await page.mouse.click(px, py);
    let rows0 = await page.evaluate(() => zonesPickedRows());
    expect(rows0.length === 1 && rows0[0].pos === '3' && rows0[0].qty === 40 && !rows0[0].orphans, 'кусок газона при общей выноске 40 м²: ' + JSON.stringify(rows0));
    await page.mouse.click(px, py);
    // Кромка клумбы (штучная позиция) отдельной фигурой без выноски — выбирается вместе с клумбой, не «без выноски».
    const [ex, ey] = await planToScreen(page, 30, 38.5);
    await page.mouse.click(ex, ey);
    const rowsE = await page.evaluate(() => zonesPickedRows());
    expect(rowsE.length === 1 && rowsE[0].pos === '2' && rowsE[0].qty === 200 && !rowsE[0].orphans, 'кромка клумбы 200 шт.: ' + JSON.stringify(rowsE));
    await page.mouse.click(ex, ey);
    const [sx, sy] = await planToScreen(page, 75, 52.5);
    await page.mouse.click(sx, sy);
    const rows = await page.evaluate(() => zonesPickedRows());
    expect(rows.length === 1 && rows[0].pos === '3' && rows[0].orphans === 1 && near(rows[0].qty, 50, 1.5), 'выбор участка без выноски: ' + JSON.stringify(rows));
    // Обычные подсчёты не изменились.
    const [tx, ty] = await planToScreen(page, 40, 44);
    await page.mouse.click(tx, ty);
    const r3 = await page.evaluate(() => zonesPickedRows().find(r => r.pos === '3'));
    expect(near(r3.qty, 130, 1.5) && r3.parcels === 2, 'газон 80 м² + участок без выноски 50 м² = 130 м², получено ' + JSON.stringify(r3));
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('По зонам работает на телефоне', async () => {
    const page = await openApp({ width: 390, height: 800 });
    await openZones(page);
    const [sx, sy] = await planToScreen(page, 30, 34);
    await page.mouse.click(sx, sy);
    const n = await page.evaluate(() => zonesState.picked.size);
    expect(n === 1, 'на узком экране выбор участка не сработал');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Кнопки «?» открывают подсказки', async () => {
    const page = await openApp();
    await page.evaluate(() => showVolumesScreen());
    await page.click('#volumesScreen button[title^="Подсказка"]');
    expect(await visible(page, '#helpModal'), 'подсказка «Объёмы» не открылась');
    expect((await page.$eval('#helpModalBody', e => e.innerText)).includes('Осталось'), 'в подсказке нет объяснения «Осталось»');
    await page.evaluate(() => closeModal('helpModal'));
    await openZones(page);
    await page.click('#zonesModal button[title^="Подсказка"]');
    expect(await visible(page, '#helpModal'), 'подсказка «По зонам» не открылась');
});

// Настоящий service worker (в остальных проверках он отключён): страница должна открываться и через него,
// в том числе повторно, когда он уже управляет страницей. Ошибка здесь = приложение не откроется на телефоне.
test('Приложение открывается повторно через service worker', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.fulfill({ status: 200, body: '' }));
    await page.route(/supabase-js/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
    await page.goto(baseUrl + '/');
    const ok = await page.evaluate(() => Promise.race([
        navigator.serviceWorker.ready.then(() => new Promise(r => navigator.serviceWorker.controller ? r(true) : navigator.serviceWorker.addEventListener('controllerchange', () => r(true)))),
        new Promise(r => setTimeout(() => r(false), 10000)),
    ]));
    expect(ok, 'service worker не установился');
    for (const url of ['/', '/index.html']) {
        const resp = await page.goto(baseUrl + url).catch(e => e);
        expect(resp && resp.ok && resp.ok(), `через service worker страница ${url} не открылась: ${resp && resp.message || resp && resp.status()}`);
        expect(await page.evaluate(() => !!navigator.serviceWorker.controller && !!document.getElementById('scheduleScreen')), `страница ${url} открылась не через service worker или без нужного содержимого`);
    }
});

// План-график. Сегодняшнюю дату в тестах задаём сами, чтобы расчёты не зависели от дня запуска.
async function openSchedule(page, today) {
    await page.evaluate(t => { window.__scheduleToday = t; appData.currentProjectId = 'p1'; }, today);
    await page.evaluate(() => showScheduleScreen());
    await page.waitForFunction(() => scheduleState.projectId === 'p1');
}
// Одна работа: 100 шт, 1 человек делает 10 в смену, бригада 2 → 20 в день, 5 рабочих дней пн 05.10 – пт 09.10.
function seedScheduleItem(page, settings) {
    return page.evaluate(settings => {
        __db.schedule_settings.push({ project_id: 'p1', workdays: 6, ...settings });
        __db.schedule_items.push({ id: 'w1', project_id: 'p1', sort_order: 1, section: 'Озеленение', name: 'Посадка кустарников', unit: 'шт', qty: 100, norm: 10, crew: 2, machine: 'Мини-погрузчик', machine_count: 1, start_date: '2026-10-05', end_date: '2026-10-09' });
    }, settings);
}

test('План-график: составляется из объёмов по нормам выработки', async () => {
    const page = await openApp({ admin: true });
    await page.evaluate(() => showVolumesScreen());
    await importFromDrawings(page);
    await openSchedule(page, '2026-10-12');
    expect((await page.$eval('#scheduleSummary', e => e.innerText)).includes('Графика пока нет'), 'пустой график должен подсказывать, с чего начать');
    await page.click('#scheduleScreen >> text=Из объёмов');
    await page.waitForSelector('#schGenPreview table');
    await page.fill('#schGenStart', '2026-10-12');
    await page.evaluate(() => renderScheduleGenPreview());
    expect(await page.$eval('#schGenEnd', e => e.textContent) === '15.10.2026', 'окончание по плану должно быть 15.10.2026, получено ' + await page.$eval('#schGenEnd', e => e.textContent));
    expect(await page.$eval('#schGenPeak', e => e.textContent) === '8', 'в пиковый день ожидалось 8 чел.');
    // «Подобрать людей под срок»: срок 14.10 — спирею надо сделать за 1 день, значит людей больше.
    await page.fill('#schGenDeadline', '2026-10-14');
    await page.check('#schGenFit');
    expect(await page.$eval('#schGenEnd', e => e.textContent) === '14.10.2026', 'с подбором людей график не уложился в срок: ' + await page.$eval('#schGenEnd', e => e.textContent));
    expect(+(await page.$eval('#schGenPeak', e => e.textContent)) > 8, 'под срок людей должно стать больше 8');
    await page.uncheck('#schGenFit');
    await page.click('#schGenSave');
    await page.waitForFunction(() => document.getElementById('scheduleModal').classList.contains('hidden'));
    const items = await page.evaluate(() => Object.fromEntries(__db.schedule_items.map(i => [i.name, [i.qty, i.norm, i.crew, i.start_date, i.end_date, i.machine]])));
    const sp = items['Посадка кустарников: Спирея тестовая'];
    expect(Object.keys(items).length === 4, 'ожидалось 4 работы, получено ' + Object.keys(items).join(', '));
    expect(sp && sp[0] === 200 && sp[1] === 30 && sp[2] === 4 && sp[3] === '2026-10-12' && sp[4] === '2026-10-13', 'спирея: ожидалось 200 шт, норма 30, 4 чел., 12–13.10, получено ' + JSON.stringify(sp));
    const tree = items['Посадка деревьев: Клен тестовый'];
    expect(tree && tree[5] === 'Кран-манипулятор', 'для деревьев ожидался кран-манипулятор: ' + JSON.stringify(tree));
    const lawn = items['Укладка рулонного газона: Газон рулонный тестовый'];
    expect(lawn && lawn[3] === '2026-10-14', 'газон должен начинаться после посадок, 14.10: ' + JSON.stringify(lawn));
    expect(await page.evaluate(() => __db.schedule_settings[0]?.deadline) === '2026-10-14', 'срок сдачи не сохранился в настройках');
    // Повторно — без дублей.
    await page.evaluate(() => openScheduleGenerate());
    await page.waitForSelector('#schGenPreview table');
    await page.evaluate(() => saveScheduleGenerate());
    await page.waitForFunction(() => document.getElementById('scheduleModal').classList.contains('hidden'));
    expect(await page.evaluate(() => __db.schedule_items.length) === 4, 'повторное «Из объёмов» создало дубли');
    expect(await page.$$eval('#scheduleGantt .schedule-row', r => r.length) === 4, 'на диаграмме должно быть 4 строки');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('План-график: факт, отставание и что добавить, чтобы успеть', async () => {
    const page = await openApp();
    await seedScheduleItem(page, { deadline: '2026-10-09', people_available: 3 });
    // Пн и вт сделали по 10 вместо 20, среду вносим через форму.
    await page.evaluate(() => __db.schedule_progress.push(
        { id: 'f1', item_id: 'w1', project_id: 'p1', work_date: '2026-10-05', qty: 10, people: 2 },
        { id: 'f2', item_id: 'w1', project_id: 'p1', work_date: '2026-10-06', qty: 10, people: 2 }));
    await openSchedule(page, '2026-10-08');
    await page.click('#scheduleScreen >> text=Внести выполнение');
    await page.fill('#schFactDate', '2026-10-07');
    await page.fill('.schedule-fact-row[data-item="w1"] .sch-fact-qty', '10');
    await page.fill('.schedule-fact-row[data-item="w1"] .sch-fact-people', '2');
    await page.click('#schFactSave');
    await page.waitForFunction(() => document.getElementById('scheduleModal').classList.contains('hidden'));
    expect(await page.evaluate(() => __db.schedule_progress.length) === 3, 'запись о выполнении не сохранилась');
    const s = await page.evaluate(() => scheduleItemStats(scheduleState.items[0], scheduleState.progress, '2026-10-08', 6));
    // К утру четверга план 60, сделано 30: отстаём на 30 шт = 1,5 дня. Темп 10/день → остаток 70 до 15.10.
    expect(s.done === 30 && Math.round(s.pct * 100) === 30, 'сделано должно быть 30 (30%), получено ' + s.done);
    expect(s.planToDate === 60 && s.lag === 30 && s.lagDays === 1.5, `отставание: ожидалось план 60, отстаём 30 шт / 1,5 дн., получено ${s.planToDate} / ${s.lag} / ${s.lagDays}`);
    expect(s.forecastEnd === '2026-10-15' && s.late, 'прогноз окончания должен быть 15.10, получено ' + s.forecastEnd);
    expect(s.neededPeople === 4 && s.extraPeople === 2 && s.extraMachines === 1, `чтобы успеть, нужно 4 чел. (+2) и +1 техника, получено ${s.neededPeople} (+${s.extraPeople}), техника +${s.extraMachines}`);
    const advice = await page.$eval('#scheduleAdviceBox', e => e.innerText);
    expect(advice.includes('нужно 4 чел. вместо 2 (+2)') && advice.includes('+1 Мини-погрузчик'), 'в советах нет «нужно 4 чел. вместо 2 (+2)» и техники: ' + advice);
    expect(advice.includes('позже срока сдачи') && advice.includes('Не хватает 1 чел.'), 'в советах нет прогноза по сроку сдачи и нехватки людей: ' + advice);
    expect(await page.$eval('[data-people-today]', e => e.textContent) === '4', 'людей сегодня должно быть нужно 4');
    // Excel: в файле график и выполнение по дням.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#scheduleScreen >> text=Excel')]);
    const wb = XLSX.read(fs.readFileSync(await dl.path()));
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['План-график'], { header: 1 });
    const row = rows.find(r => r[1] === 'Посадка кустарников');
    expect(row && row[4] === 30 && row[12] === '15.10.2026' && row[15] === 4, 'строка в Excel неверна: ' + JSON.stringify(row));
    expect(XLSX.utils.sheet_to_json(wb.Sheets['Выполнение'], { header: 1 }).length === 4, 'на листе «Выполнение» должно быть 3 записи');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('План-график: работа ещё не началась, но по плану в срок не укладывается', async () => {
    const page = await openApp();
    await seedScheduleItem(page, {});
    await page.evaluate(() => { __db.schedule_items[0].end_date = '2026-10-07'; });   // 3 дня вместо нужных 5
    await openSchedule(page, '2026-10-01');
    const s = await page.evaluate(() => scheduleItemStats(scheduleState.items[0], [], '2026-10-01', 6));
    expect(s.status === 'notstarted' && s.late && s.forecastEnd === '2026-10-09' && s.neededPeople === 4, 'ожидалось: не начато, закончим 09.10, нужно 4 чел., получено ' + JSON.stringify(s));
    const advice = await page.$eval('#scheduleAdviceBox', e => e.innerText);
    expect(advice.includes('не укладывается в срок по плану') && advice.includes('нужно 4 чел.') && !advice.includes('отстаёт на 0'), 'неверный совет: ' + advice);
});

test('План-график: прораб вносит выполнение, но не меняет план', async () => {
    const page = await openApp({ role: 'worker' });
    await seedScheduleItem(page, {});
    await openSchedule(page, '2026-10-06');
    expect(await visible(page, '#scheduleScreen >> text=Внести выполнение'), 'прорабу не видна кнопка «Внести выполнение»');
    expect(!(await visible(page, '#scheduleScreen >> text=Из объёмов')), 'прорабу видна кнопка «Из объёмов»');
    expect(!(await visible(page, '#scheduleScreen >> text=Сроки и люди')), 'прорабу видна кнопка «Сроки и люди»');
    await page.click('.schedule-row[data-item="w1"]');
    expect(await page.$eval('#schItemQty', e => e.disabled) && !(await page.$('#schItemSave')), 'прораб может менять план работы');
    const acc = await openApp({ role: 'accountant' });
    await openSchedule(acc, '2026-10-06');
    expect(!(await visible(acc, '#scheduleScreen >> text=Внести выполнение')), 'бухгалтеру видна кнопка «Внести выполнение»');
});

test('План-график на телефоне: диаграмма, люди по неделям, подсказка', async () => {
    const page = await openApp({ width: 390, height: 800 });
    await seedScheduleItem(page, { people_available: 1 });
    await openSchedule(page, '2026-10-06');
    expect(await page.$$eval('#scheduleGantt .schedule-row', r => r.length) === 1, 'на телефоне не видна диаграмма');
    expect(await page.$$eval('.schedule-week', w => w.map(x => +x.dataset.people)).then(p => p.includes(2)), 'в неделе 05.10 по графику должно быть 2 чел.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth) <= 390, 'страница шире экрана телефона');
    await page.click('#scheduleScreen button[title^="Подсказка"]');
    expect((await page.$eval('#helpModalBody', e => e.innerText)).includes('Внести выполнение'), 'подсказка «План-график» не открылась');
    // Работа открывается нажатием на строку и сама считает окончание.
    await page.evaluate(() => closeModal('helpModal'));
    await page.click('.schedule-row[data-item="w1"]');
    await page.fill('#schItemCrew', '4');
    await page.dispatchEvent('#schItemCrew', 'input');
    expect(await page.$eval('#schItemEnd', e => e.value) === '2026-10-07', 'при 4 чел. работа 100 шт должна закончиться 07.10');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

// ================= ЗАПУСК =================
// Для снимков экрана файл можно подключить из другого скрипта: тогда проверки не запускаются.
module.exports = { openApp, openSchedule, start: async () => { css = buildCss(); const server = await startServer(); baseUrl = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch(); return { server, browser }; } };
if (require.main === module) (async () => {
    css = buildCss();
    const server = await startServer();
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch();
    const results = [];
    for (const t of tests) {
        const t0 = Date.now();
        let error = null;
        try { await t.fn(); } catch (e) { error = (e.message || String(e)).split('\n')[0]; }
        for (const c of browser.contexts()) await c.close();
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        results.push({ name: t.name, error, sec });
        console.log(`${error ? '❌' : '✅'} ${t.name} (${sec} с)${error ? '\n     → ' + error : ''}`);
    }
    await browser.close();
    server.close();
    const failed = results.filter(r => r.error);
    const head = failed.length ? `❌ Не прошли ${failed.length} из ${results.length} проверок — публиковать нельзя` : `✅ Все проверки пройдены: ${results.length} из ${results.length}`;
    console.log('\n' + head);
    if (process.env.GITHUB_STEP_SUMMARY) {
        const md = [`## Автотесты SKKG Pro`, '', `**${head}**`, '', '| | Проверка | Время |', '|---|---|---|',
            ...results.map(r => `| ${r.error ? '❌' : '✅'} | ${r.name}${r.error ? '<br>_' + r.error.replace(/\|/g, '/') + '_' : ''} | ${r.sec} с |`)].join('\n');
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
    }
    process.exit(failed.length ? 1 : 0);
})();
