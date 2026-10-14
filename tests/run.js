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
const JSPDF_JS = fs.readFileSync(require.resolve('jspdf/dist/jspdf.umd.min.js'), 'utf8');

// Стили Tailwind собираем заранее из index.html, чтобы тестам не нужен был интернет.
function buildCss() {
    const out = path.join(__dirname, '.tailwind.css');
    const input = path.join(__dirname, '.tailwind-in.css');
    fs.writeFileSync(input, '@tailwind base;@tailwind components;@tailwind utilities;');
    execFileSync(process.execPath, [require.resolve('tailwindcss/lib/cli.js'), '-c', path.join(__dirname, 'tailwind.config.js'), '-i', input, '-o', out, '--minify'], { stdio: 'ignore' });
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
    await page.route(/vendor\/supabase\.js/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
    // Оформление собираем из текущего index.html, чтобы проверки видели все новые классы.
    await page.route(/vendor\/app\.css/, r => r.fulfill({ contentType: 'text/css', body: css }));
    // Служебный обработчик (service worker) в тестах пустой, чтобы он не кэшировал файлы между проверками.
    await page.route(/service-worker\.js/, r => r.fulfill({ contentType: 'application/javascript', body: 'self.addEventListener("install", () => self.skipWaiting());' }));
    await page.route(/xlsx[^/]*\.js/, r => r.fulfill({ contentType: 'application/javascript', body: XLSX_JS }));
    await page.route(/jspdf[^/]*\.js/, r => r.fulfill({ contentType: 'application/javascript', body: JSPDF_JS }));
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

test('Загрузка листа: внутри проекта — только в этот проект, из общего меню — проект выбирают сами', async () => {
    const page = await openApp({ admin: true });
    page.on('dialog', d => d.dismiss());
    await page.evaluate(() => { __db.projects.push({ id: 'p2', name: 'Ситибэй' }); appData.projects.push({ id: 'p2', name: 'Ситибэй' }); });
    // Из общего меню: выбор проекта есть и пустой, пока не выберешь.
    await page.click('#navDrawingsBtn');
    await page.click('button:has-text("Загрузить лист")');
    expect(await visible(page, '#drawingUploadProject'), 'из общего меню нет выбора проекта');
    expect(await page.$eval('#drawingUploadProject', s => s.value === '' && s.required), 'проект подставлен заранее, а должен выбираться');
    await page.selectOption('#drawingUploadProject', 'p2');
    // Зашли в проект и оттуда в «Чертежи»: форма открывается заново, выбора нет, проект — текущий.
    await page.evaluate(() => openProject('p1'));
    await page.click('#navDrawingsBtn');
    expect(!(await visible(page, '#drawingUploadForm')), 'осталась открытой форма от общего меню');
    await page.click('button:has-text("Загрузить лист")');
    expect(!(await visible(page, '#drawingUploadProject')), 'внутри проекта виден выбор проекта');
    const fixed = await page.$eval('#drawingUploadProjectFixed', el => el.getClientRects().length ? el.innerText : '');
    expect(fixed.includes('Тестовый проект'), 'не написано, в какой проект загрузится лист: ' + fixed);
    await page.evaluate(() => { document.getElementById('drawingUploadProject').value = 'p2'; });
    await page.fill('#drawingUploadSheet', 'Бортовые камни');
    await page.setInputFiles('#drawingUploadFile', { name: 'b.html', mimeType: 'text/html', buffer: Buffer.from('<html></html>') });
    await page.click('#drawingUploadBtn');
    await page.waitForFunction(() => __db.drawings.some(d => d.sheet === 'Бортовые камни'));
    const pid = await page.evaluate(() => __db.drawings.find(d => d.sheet === 'Бортовые камни').project_id);
    expect(pid === 'p1', 'лист ушёл в другой проект: ' + pid);
    // В разделе «Чертежи» внутри самого проекта — тоже без выбора.
    await page.evaluate(() => openProject('p1'));
    await page.evaluate(() => toggleDrawingUploadForm('project'));
    expect(!(await visible(page, '#drawingUploadProject')) && await visible(page, '#drawingUploadProjectFixed'), 'в разделе проекта есть выбор проекта');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
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

test('Лист без плана (конструкции покрытий): объёмы слоёв идут в «Объёмы», «По зонам» не ломается', async () => {
    // Как лист 7 «Конструкции дорожных одежд»: только таблица слоёв и список skkg-quantities, плана нет.
    const html = `<!doctype html><h1>Конструкции</h1><script id="skkg-quantities" type="application/json">${JSON.stringify([
        { pos: 'К1', name: 'Бетон В15 тестовый', unit: 'м³', qty: 952.04, category: 'Основания покрытий (слои)' },
        { pos: 'К2', name: 'Плёнка тестовая', unit: 'м²', qty: 7736.51, category: 'Основания покрытий (слои)' },
    ])}</script>`;
    const page = await openApp({ admin: true });
    await page.evaluate(h => { __files['p1/test-sheet.html'] = h; }, html);
    await page.evaluate(() => showVolumesScreen());
    await importFromDrawings(page);
    const m = await materialsByName(page);
    expect(m['Бетон В15 тестовый'] === 952.04 && m['Плёнка тестовая'] === 7736.51, 'слои не попали в объёмы: ' + JSON.stringify(m));
    const cat = await page.evaluate(() => __db.materials.map(x => x.category));
    expect(cat.every(c => c === 'Основания покрытий (слои)'), 'группа слоёв потерялась: ' + JSON.stringify(cat));
    await page.click('text=По зонам');
    await page.waitForFunction(() => /нет плана/.test(document.getElementById('zonesLoading').textContent), null, { timeout: 15000 });
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
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

test('По зонам: лист покрытий — участки лежат друг на друге, каждый выбирается со своей площадью', async () => {
    // Как на плане покрытий: большая плитка (20 м²) и вставка другого цвета (2 м²) внутри неё; остриё выноски
    // вставки попадает в обе фигуры. Лист прямо связывает фигуру с её выноской (data-c → data-h).
    const rect = (x, y, w, h) => `M${x} ${y}l${w} 0 0 ${h} ${-w} 0z`;
    const plan = [
        `<g class="it ld" data-s="lbl" data-h="B1" data-p="5" data-q="2 м²"><rect class="hb" x="2" y="40" width="3" height="2"/><path class="ln" stroke="#000" d="M3 41l6 10"/></g>`,
        `<g class="it ld" data-s="lbl" data-h="A1" data-p="5" data-q="20 м²"><rect class="hb" x="20" y="40" width="3" height="2"/><path class="ln" stroke="#000" d="M21 41l-7 10"/></g>`,
        `<g class="it" data-s="cov" data-l="Test" data-p="5" data-src="tip" data-c="A1"><path fill="#ffffca" d="${rect(6, 50, 10, 2)}"/></g>`,
        `<g class="it" data-s="cov" data-l="Test" data-p="5" data-src="tip" data-c="B1"><path fill="#c4a5e5" d="${rect(8, 50.5, 2, 1)}"/></g>`,
    ].join('');
    const planz = require('zlib').gzipSync(Buffer.from(plan)).toString('base64');
    const html = `<!doctype html><svg id="plan" viewBox="0 30 30 30"><g id="root"></g></svg><script>
const S=[["Покрытия",[["5","Покрытие тестовое","м²","22"]]]];
const TIPS={"5":[[9,51],[14,51]]};
const PLANZ="${planz}";</script>`;
    const page = await openApp();
    await page.evaluate(h => { __files['p1/test-sheet.html'] = h; }, html);
    await openZones(page);
    const st = await page.evaluate(() => [...zonesState.parcels.values()].map(p => ({ q: p.qty, els: p.els.length })).sort((a, b) => a.q - b.q));
    expect(JSON.stringify(st) === JSON.stringify([{ q: 2, els: 1 }, { q: 20, els: 1 }]), 'у каждой выноски своя фигура: ' + JSON.stringify(st));
    const [bx, by] = await planToScreen(page, 9, 51);
    await page.mouse.click(bx, by);
    let rows = await page.evaluate(() => zonesPickedRows());
    expect(rows.length === 1 && rows[0].qty === 2, 'нажатие на вставку — 2 м²: ' + JSON.stringify(rows));
    await page.mouse.click(bx, by);
    const [ax, ay] = await planToScreen(page, 14, 51);
    await page.mouse.click(ax, ay);
    rows = await page.evaluate(() => zonesPickedRows());
    expect(rows.length === 1 && rows[0].qty === 20, 'нажатие на плитку вокруг — 20 м²: ' + JSON.stringify(rows));
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('По зонам: у выбранного участка покрытия виден пирог — слои и их объёмы', async () => {
    // Лист 6.1 со встроенным пирогом (листы 7.1–7.2): под плиткой бетон 120 мм (м³) и плёнка (м²).
    const rect = (x, y, w, h) => `M${x} ${y}l${w} 0 0 ${h} ${-w} 0z`;
    const plan = [
        `<g class="it ld" data-s="lbl" data-h="A1" data-p="5" data-q="20 м²"><rect class="hb" x="20" y="40" width="3" height="2"/><path class="ln" stroke="#000" d="M21 41l-7 10"/></g>`,
        `<g class="it ld" data-s="lbl" data-h="C1" data-p="6" data-q="4 м²"><rect class="hb" x="2" y="40" width="3" height="2"/><path class="ln" stroke="#000" d="M3 41l1 13"/></g>`,
        `<g class="it" data-s="cov" data-l="Test" data-p="5" data-src="tip" data-c="A1"><path fill="#ffffca" d="${rect(6, 50, 10, 2)}"/></g>`,
        `<g class="it" data-s="cov" data-l="Test" data-p="6" data-src="tip" data-c="C1"><path fill="#c4a5e5" d="${rect(3, 53, 2, 2)}"/></g>`,
    ].join('');
    const planz = require('zlib').gzipSync(Buffer.from(plan)).toString('base64');
    const pirog = { 5: { t: 'Плитка', top: 'Плитка 80 мм', L: [['Бетон тестовый', 'м³', 120, 'conc'], ['Плёнка тестовая', 'м²', null, 'film']] },
                    6: { t: 'Асфальт', top: 'Асфальт 50 мм', L: [['Бетон тестовый', 'м³', 200, 'conc']] } };
    const html = `<!doctype html><svg id="plan" viewBox="0 30 30 30"><g id="root"></g></svg>
<script id="skkg-pirog" type="application/json">${JSON.stringify(pirog)}</script><script>
const S=[["Покрытия",[["5","Плитка тестовая","м²","20"],["6","Асфальт тестовый","м²","4"]]]];
const TIPS={"5":[[14,51]],"6":[[4,54]]};
const PLANZ="${planz}";</script>`;
    const page = await openApp();
    await page.evaluate(h => { __files['p1/test-sheet.html'] = h; }, html);
    await openZones(page);
    expect(!(await page.$('#zonesPirog')), 'пирог виден, хотя ничего не выбрано');
    const [ax, ay] = await planToScreen(page, 14, 51);
    await page.mouse.click(ax, ay);
    let layers = await page.evaluate(() => zonesPirogRows(zonesPickedRows()));
    expect(JSON.stringify(layers.map(l => [l.name, l.unit, l.qty])) === JSON.stringify([['Бетон тестовый', 'м³', 2.4], ['Плёнка тестовая', 'м²', 20]]),
        'участок 20 м²: бетон 20 × 0,12 = 2,4 м³ и плёнка 20 м², получено ' + JSON.stringify(layers));
    const [cx, cy] = await planToScreen(page, 4, 54);
    await page.mouse.click(cx, cy);
    layers = await page.evaluate(() => zonesPirogRows(zonesPickedRows()));
    const beton = layers.find(l => l.name === 'Бетон тестовый');
    expect(beton && beton.qty === 3.2 && beton.types.join() === '5,6', 'бетон двух типов складывается: 2,4 + 4 × 0,2 = 3,2 м³, получено ' + JSON.stringify(beton));
    const text = await page.$eval('#zonesPirog', el => el.innerText);
    expect(/Бетон тестовый/.test(text) && /3,2/.test(text) && /Плёнка тестовая/.test(text), 'в панели нет слоёв: ' + text);
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

// Открыть лист в просмотре и включить «Замечания». user — кто вошёл.
async function openNotes(page, user = { id: 'u1', full_name: 'Грег' }) {
    await page.evaluate(async u => {
        currentUserProfile = u;
        appData.drawings = __db.drawings.map(d => ({ ...d }));
        await openDrawingViewer('d1');
        await toggleDrawingNotes();
    }, user);
    await page.waitForFunction(() => notesState?.vb, null, { timeout: 15000 });
}
const notesToScreen = (page, x, y) => page.evaluate(([x, y]) => {
    const svg = document.getElementById('notesSvg'), pt = svg.createSVGPoint();
    pt.x = x; pt.y = y;
    const r = pt.matrixTransform(svg.getScreenCTM());
    return [r.x, r.y];
}, [x, y]);
async function notesDrag(page, from, to) {
    const [ax, ay] = await notesToScreen(page, ...from), [bx, by] = await notesToScreen(page, ...to);
    await page.mouse.move(ax, ay); await page.mouse.down();
    await page.mouse.move((ax + bx) / 2, (ay + by) / 2); await page.mouse.move(bx, by); await page.mouse.up();
}

test('Замечания: рисую прямоугольник и стрелку с подписью — сохраняется и видно после повторного открытия', async () => {
    const page = await openApp();
    await openNotes(page);
    const vb = await page.evaluate(() => notesState.vb);
    const P = (fx, fy) => [vb[0] + vb[2] * fx, vb[1] + vb[3] * fy];
    // Линии чертежа рисуются линиями, а не залитыми чёрным фигурами.
    const fill = await page.evaluate(() => { const el = document.querySelector('#notesPlan .st[stroke], #notesPlan .ln'); return el ? getComputedStyle(el).fill : 'none'; });
    expect(fill === 'none', 'линии чертежа залиты: ' + fill);
    await page.click('#notesToolbar [data-tool="rect"]');
    await page.click('#notesToolbar [data-color="#2563eb"]');
    await notesDrag(page, P(0.3, 0.3), P(0.5, 0.45));
    await page.waitForFunction(() => __db.drawing_notes?.length === 1);
    await page.fill('#noteTextInput', 'Переложить плитку');
    await page.press('#noteTextInput', 'Enter');
    await page.click('#notesToolbar [data-tool="arrow"]');
    await notesDrag(page, P(0.7, 0.7), P(0.55, 0.5));
    await page.waitForFunction(() => __db.drawing_notes?.length === 2);
    const rows = await page.evaluate(() => __db.drawing_notes.map(r => ({ kind: r.kind, color: r.color, text: r.text, sheet: r.sheet, project: r.project_id, author: r.author_id, data: r.data })));
    const rect = rows.find(r => r.kind === 'rect');
    expect(rect && rect.color === '#2563eb' && rect.text === 'Переложить плитку' && rect.project === 'p1' && rect.author === 'u1' && rect.sheet === 'лист 1 тестовый посадочный план',
        'прямоугольник сохранён неверно: ' + JSON.stringify(rect));
    expect(near(rect.data.x, P(0.3, 0)[0], vb[2] * 0.01) && near(rect.data.w, vb[2] * 0.2, vb[2] * 0.01), 'координаты прямоугольника не в единицах чертежа: ' + JSON.stringify(rect.data));
    expect(rows.some(r => r.kind === 'arrow' && r.data.pts.length === 2), 'стрелка не сохранилась');
    // Закрыли и открыли заново — пометки на месте.
    await page.evaluate(() => closeDrawingViewer());
    await openNotes(page);
    const shown = await page.evaluate(() => document.querySelectorAll('#notesMarks [data-note]').length);
    expect(shown === 2, 'после повторного открытия видно пометок: ' + shown);
    expect(/Переложить плитку/.test(await page.$eval('#notesList', el => el.innerText)), 'в списке нет подписи замечания');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Замечания: выделяю нарисованное — двигаю, растягиваю, тяну конец стрелки, меняю размер подписи', async () => {
    const page = await openApp();
    await openNotes(page);
    const vb = await page.evaluate(() => notesState.vb);
    const P = (fx, fy) => [vb[0] + vb[2] * fx, vb[1] + vb[3] * fy];
    const W = vb[2], tol = W * 0.01;
    const note = kind => page.evaluate(k => JSON.parse(JSON.stringify(__db.drawing_notes.find(n => n.kind === k))), kind);
    // Прямоугольник: сдвиг за середину и растяжение за правый нижний угол.
    await page.click('#notesToolbar [data-tool="rect"]');
    await notesDrag(page, P(0.2, 0.2), P(0.4, 0.4));
    await page.waitForFunction(() => __db.drawing_notes.length === 1);
    await page.click('#notesToolbar [data-tool="pan"]');
    const r0 = await note('rect');
    await notesDrag(page, P(0.3, 0.3), P(0.35, 0.3));
    let r = await note('rect');
    expect(near(r.data.x, r0.data.x + W * 0.05, tol) && near(r.data.w, r0.data.w, tol), 'прямоугольник не сдвинулся: ' + JSON.stringify([r0.data, r.data]));
    await notesDrag(page, [r.data.x + r.data.w, r.data.y + r.data.h], [r.data.x + r.data.w + W * 0.1, r.data.y + r.data.h]);
    const r2 = await note('rect');
    expect(near(r2.data.w, r.data.w + W * 0.1, tol) && near(r2.data.x, r.data.x, tol), 'прямоугольник не растянулся: ' + JSON.stringify([r.data, r2.data]));
    // Стрелка: тяну её конец.
    await page.click('#notesToolbar [data-tool="arrow"]');
    await notesDrag(page, P(0.6, 0.6), P(0.7, 0.7));
    await page.waitForFunction(() => __db.drawing_notes.length === 2);
    await page.click('#notesToolbar [data-tool="pan"]');
    const a0 = await note('arrow');
    await notesDrag(page, a0.data.pts[1], P(0.8, 0.65));
    const a = await note('arrow');
    expect(near(a.data.pts[1][0], P(0.8, 0)[0], tol) && near(a.data.pts[0][0], a0.data.pts[0][0], tol), 'конец стрелки не переместился: ' + JSON.stringify(a.data));
    // Подпись: размер из списка, затем растягиваю за угол.
    await page.selectOption('#notesFont', 'l');
    page.once('dialog', d => d.accept('Проверить'));
    await page.click('#notesToolbar [data-tool="text"]');
    const [tx, ty] = await notesToScreen(page, ...P(0.3, 0.7));
    await page.mouse.click(tx, ty);
    await page.waitForFunction(() => __db.drawing_notes.length === 3);
    const base = await page.evaluate(() => notesState.baseVb[2]);
    let t = await note('text');
    expect(near(t.data.size, base * 0.017, base * 0.0005), 'подпись не того размера: ' + t.data.size);
    await page.click('#notesToolbar [data-tool="pan"]');
    await page.selectOption('#notesFont', 's');
    t = await note('text');
    expect(near(t.data.size, base * 0.007, base * 0.0005), 'размер выделенной подписи не поменялся: ' + t.data.size);
    const se = await page.evaluate(() => { const r = document.querySelector('#notesDraft [data-handle="se"]').getBBox(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await notesDrag(page, se, [se[0] + (se[0] - t.data.x), se[1]]);
    const t2 = await note('text');
    expect(t2.data.size > t.data.size * 1.6, 'подпись не увеличилась за угол: ' + t.data.size + ' → ' + t2.data.size);
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Замечания: чужую пометку удаляет только ответственный за чертежи, «Исправлено» отмечается', async () => {
    const add = page => page.evaluate(() => __db.drawing_notes = [
        { id: 'n1', project_id: 'p1', sheet: 'лист 1 тестовый посадочный план', author_id: 'u2', author_name: 'Прораб', kind: 'rect', color: '#dc2626', data: { x: 0, y: 0, w: 5, h: 5 }, text: 'Бордюр', resolved: false, created_at: '2026-10-14T05:00:00Z' }]);
    const worker = await openApp();
    await add(worker);
    await openNotes(worker, { id: 'u3', full_name: 'Мастер' });
    await worker.evaluate(() => notesSelect('n1', true));
    const btns = await worker.$$eval('[data-note-row="n1"] button', b => b.map(x => x.innerText.trim()));
    expect(!btns.includes('Удалить') && !btns.includes('Исправлено'), 'не ответственный может менять чужую пометку: ' + JSON.stringify(btns));
    const admin = await openApp({ admin: true });
    await add(admin);
    await openNotes(admin);
    await admin.evaluate(() => notesSelect('n1', true));
    await admin.click('[data-note-row="n1"] >> text=Исправлено');
    expect(await admin.evaluate(() => __db.drawing_notes[0].resolved === true), '«Исправлено» не сохранилось');
    admin.once('dialog', d => d.accept());
    await admin.click('[data-note-row="n1"] >> text=Удалить');
    await admin.waitForFunction(() => __db.drawing_notes.length === 0);
    expect(!admin.errors.length && !worker.errors.length, 'ошибки на странице: ' + admin.errors.concat(worker.errors).join('; '));
});

test('Замечания: скачать картинкой — JPEG с планом и пометками', async () => {
    const page = await openApp();
    await openNotes(page);
    const vb = await page.evaluate(() => notesState.vb);
    await page.click('#notesToolbar [data-tool="ellipse"]');
    await notesDrag(page, [vb[0] + vb[2] * 0.4, vb[1] + vb[3] * 0.4], [vb[0] + vb[2] * 0.6, vb[1] + vb[3] * 0.6]);
    await page.waitForFunction(() => __db.drawing_notes?.length === 1);
    // Имя файла запоминаем при нажатии ссылки: безголовый Chromium в тестах не передаёт русские имена скачиваний.
    await page.evaluate(() => { const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { window.__dlName = this.download; return c.call(this); }; });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#notesToolbar >> text=JPEG')]);
    const file = await dl.path();
    const buf = fs.readFileSync(file);
    const name = await page.evaluate(() => window.__dlName);
    expect(/\.jpg$/.test(name) && /Лист 1/.test(name), 'имя файла: ' + name);
    expect(buf[0] === 0xff && buf[1] === 0xd8 && buf.length > 20000, `это не JPEG или он пустой: ${buf.length} байт`);
    // Чёткая и без пустых полей: длинная сторона ~5000 точек, кадр по чертежу и пометкам, а не по окну.
    const dims = await page.evaluate(async () => {
        await notesFit();
        const b = await notesBuildJpeg(), url = URL.createObjectURL(b);
        const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = url; });
        const reg = notesExportRegion(), plan = document.getElementById('notesPlan').getBBox();
        return { w: img.naturalWidth, h: img.naturalHeight, reg, plan: [plan.x, plan.y, plan.width, plan.height], vb: notesState.vb };
    });
    expect(Math.max(dims.w, dims.h) >= 4500, 'картинка мелкая: ' + dims.w + '×' + dims.h);
    expect(dims.reg[2] < dims.vb[2] * 0.999 || dims.reg[3] < dims.vb[3] * 0.999, 'пустые поля окна попали в картинку: ' + JSON.stringify(dims));
    expect(near(dims.reg[2], dims.plan[2] * 1.03, dims.plan[2] * 0.02) || dims.reg[3] <= dims.plan[3] * 1.05, 'кадр не по чертежу: ' + JSON.stringify(dims));
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Замечания: скачать в PDF — лист с планом и пометками', async () => {
    const page = await openApp();
    await openNotes(page);
    const vb = await page.evaluate(() => notesState.vb);
    await page.click('#notesToolbar [data-tool="rect"]');
    await notesDrag(page, [vb[0] + vb[2] * 0.4, vb[1] + vb[3] * 0.4], [vb[0] + vb[2] * 0.6, vb[1] + vb[3] * 0.6]);
    await page.waitForFunction(() => __db.drawing_notes?.length === 1);
    await page.evaluate(() => { const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { window.__dlName = this.download; return c.call(this); }; });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#notesToolbar >> text=PDF')]);
    const buf = fs.readFileSync(await dl.path());
    const name = await page.evaluate(() => window.__dlName);
    expect(/\.pdf$/.test(name) && /Лист 1/.test(name), 'имя файла: ' + name);
    expect(buf.slice(0, 4).toString() === '%PDF' && buf.length > 20000, `это не PDF или он пустой: ${buf.length} байт`);
    expect(/\/DCTDecode/.test(buf.toString('latin1')), 'в PDF нет картинки чертежа');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Замечания на телефоне: рисуется пальцем, список под планом', async () => {
    const page = await openApp({ width: 390, height: 800 });
    await openNotes(page);
    const box = await page.$eval('#notesSvg', el => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
    expect(box[2] > 300 && box[3] > 250, 'план на телефоне слишком маленький: ' + JSON.stringify(box));
    const listTop = await page.$eval('#notesList', el => el.getBoundingClientRect().top);
    expect(listTop >= box[1] + box[3] - 1, 'список замечаний налезает на план');
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW <= 390, 'страница шире экрана: ' + scrollW);
    await page.click('#notesToolbar [data-tool="pen"]');
    const vb = await page.evaluate(() => notesState.vb);
    await notesDrag(page, [vb[0] + vb[2] * 0.3, vb[1] + vb[3] * 0.5], [vb[0] + vb[2] * 0.6, vb[1] + vb[3] * 0.55]);
    await page.waitForFunction(() => __db.drawing_notes?.length === 1 && __db.drawing_notes[0].kind === 'pen');
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
    await page.route(/vendor\/supabase\.js/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
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

// ---- Сайт открывается всегда ----
const ROOT_FILE = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('Все библиотеки и стили — с нашего сайта, а не с чужих серверов', async () => {
    const html = ROOT_FILE('index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    const ext = [...head.matchAll(/<(?:script|link)[^>]+(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1]);
    expect(!ext.length, 'в начале страницы подключено с чужих серверов: ' + ext.join(', '));
    const loaders = [...html.matchAll(/\.src\s*=\s*['"](https?:[^'"]+)/g)].map(m => m[1]);
    expect(!loaders.length, 'библиотеки догружаются с чужих серверов: ' + loaders.join(', '));
    const local = [...html.matchAll(/(?:src|href)="(vendor\/[^"?]+)/g)].map(m => m[1]);
    const sw = ROOT_FILE('service-worker.js');
    const swFiles = [...sw.matchAll(/'(vendor\/[^']+|icons\/[^']+|manifest\.json)'/g)].map(m => m[1]);
    const missing = [...local, ...swFiles].filter(f => !fs.existsSync(path.join(ROOT, f)));
    expect(local.length >= 6 && !missing.length, 'нет файлов на сайте: ' + missing.join(', '));
    const fa = ROOT_FILE('vendor/fontawesome/css/all.min.css');
    const fonts = [...fa.matchAll(/url\(\.\.\/webfonts\/([^)]+\.woff2)\)/g)].map(m => m[1]).filter(f => !fs.existsSync(path.join(ROOT, 'vendor/fontawesome/webfonts', f)));
    expect(!fonts.length, 'нет файлов иконок: ' + fonts.join(', '));
});

test('Версия одна во всех местах: страница, ссылки ?v=, service worker, version.json', async () => {
    const html = ROOT_FILE('index.html');
    const v = (html.match(/window\.APP_VERSION = '([^']+)'/) || [])[1];
    const vs = new Set([...html.matchAll(/\?v=([0-9a-z.-]+)"/g)].map(m => m[1]));
    const sw = (ROOT_FILE('service-worker.js').match(/const VERSION = '([^']+)'/) || [])[1];
    const vj = JSON.parse(ROOT_FILE('version.json')).version;
    expect(v && vs.size === 1 && vs.has(v) && sw === v && vj === v, `версии разные: страница ${v}, ссылки ${[...vs]}, service worker ${sw}, version.json ${vj}`);
});

test('Оформление vendor/app.css собрано из текущей страницы', async () => {
    const built = ROOT_FILE('vendor/app.css');
    expect(built === css, 'vendor/app.css устарел: в папке tests выполните «npm run css» и закоммитьте его');
});

test('Не скачалась библиотека — вместо вечной загрузки понятное сообщение и сброс', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    await page.route(/vendor\/supabase\.js/, r => r.abort());
    await page.goto(baseUrl + '/index.html');
    await page.waitForSelector('#bootProblem', { timeout: 10000 });
    const text = await page.$eval('#bootProblem', e => e.innerText);
    expect(text.includes('Приложение не открылось') && text.includes('vendor/supabase.js'), 'сообщение без причины: ' + text);
    expect(await visible(page, '#bootReset'), 'нет кнопки сброса');
    await page.waitForFunction(() => /связ/.test(document.getElementById('bootNet').textContent) && !/Проверяю/.test(document.getElementById('bootNet').textContent), null, { timeout: 12000 });
    // Сброс удаляет сохранённые файлы и перезагружает страницу, вход (localStorage) не трогает.
    await page.evaluate(async () => { localStorage.setItem('workcontrol-auth', 'x'); const c = await caches.open('test-old'); await c.put('/x', new Response('1')); });
    await page.unroute(/vendor\/supabase\.js/);
    await page.route(/vendor\/supabase\.js/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
    await Promise.all([page.waitForURL(/\?r=\d+/), page.click('#bootReset')]);
    await page.waitForFunction(() => window.__appStarted, null, { timeout: 10000 });
    const after = await page.evaluate(async () => ({ caches: (await caches.keys()).filter(k => k === 'test-old').length, auth: localStorage.getItem('workcontrol-auth') }));
    expect(after.caches === 0 && after.auth === 'x', 'сброс сработал неправильно: ' + JSON.stringify(after));
    expect(!(await page.$('#bootProblem')), 'после сброса сообщение не пропало');
});

test('После публикации новой версии появляется кнопка «Обновить»', async () => {
    const page = await openApp({ width: 390, height: 800 });
    await page.route(/version\.json/, r => r.fulfill({ contentType: 'application/json', body: '{"version":"999"}' }));
    await page.evaluate(() => checkForNewVersion());
    await page.waitForSelector('#updateBanner', { timeout: 5000 });
    const box = await page.$eval('#updateBanner', e => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.bottom]; });
    expect(box[0] >= 0 && box[1] <= 390 && box[2] <= 800, 'кнопка «Обновить» не помещается на экране телефона: ' + box);
    await page.unroute(/version\.json/);
    await page.route(/version\.json/, r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: ROOT_FILE('version.json').match(/"version":\s*"([^"]+)/)[1] }) }));
    const page2 = await openApp();
    await page2.evaluate(() => checkForNewVersion());
    await page2.waitForTimeout(500);
    expect(!(await page2.$('#updateBanner')), 'кнопка «Обновить» появилась без новой версии');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Без связи приложение открывается из сохранённых на телефоне файлов', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.abort());
    await page.route(/vendor\/supabase\.js/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
    await page.goto(baseUrl + '/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.__appStarted, null, { timeout: 15000 });
    const ok = await page.evaluate(() => ({ supa: typeof supabase === 'object', css: getComputedStyle(document.getElementById('authCheckingScreen') || document.body).position, icons: [...document.fonts].some(f => /Font Awesome/.test(f.family)) }));
    expect(ok.supa, 'без связи не открылась библиотека базы');
    expect(!(await page.$('#bootProblem')), 'без связи появилось сообщение об ошибке запуска');
    await context.setOffline(false);
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

test('Задачи: счётчики сверху сходятся с разделами (галочка = выполнено)', async () => {
    const page = await openApp();
    const r = await page.evaluate(() => {
        const d = n => getFormattedDate(n);
        appData.currentProjectId = 'p1';
        appData.tasks = [
            { id: 't1', projectId: 'p1', title: 'А', category: 'Участок 1', status: 'new', dueDate: d(5) },
            { id: 't2', projectId: 'p1', title: 'Б', category: 'Участок 1', status: 'in_progress', dueDate: d(-2) },
            { id: 't3', projectId: 'p1', title: 'В', category: 'Участок 2', status: 'review', dueDate: d(3) },
            { id: 't4', projectId: 'p1', title: 'Г', category: 'Участок 2', status: 'completed', dueDate: d(-5) },
            { id: 't5', projectId: 'p1', title: 'Д', category: 'Участок 2', status: 'in_progress', dueDate: d(-1), struck: true },
        ];
        renderProjectOverview();
        appData.groupingMode = 'category';
        document.getElementById('statusFilter').value = 'all';
        renderTasksList();
        const num = id => +document.getElementById(id).innerText;
        const heads = [...document.querySelectorAll('#tasksContainer h3')].map(h => h.closest('div.min-w-0').innerText.replace(/\s+/g, ' '));
        const filtered = v => { document.getElementById('statusFilter').value = v; return getFilteredTasks().map(t => t.id).join(','); };
        const pdf = buildScheduleReportContainer('category').innerText;
        return { pdfOver: (pdf.match(/ПРОСРОЧЕНО/g) || []).length,
            total: num('statTotalTasks'), fresh: num('statNew'), prog: num('statInProgress'), done: num('statCompleted'), over: num('statOverdue'), heads,
            fNew: filtered('new'), fProg: filtered('in_progress'), fDone: filtered('completed'), fOver: filtered('overdue') };
    });
    expect(r.total === 5 && r.fresh === 1 && r.prog === 2 && r.done === 2 && r.over === 1, 'счётчики сверху: ' + JSON.stringify(r));
    expect(r.fresh + r.prog + r.done === r.total, 'Новые + В процессе + Завершено должно равняться Всего: ' + JSON.stringify(r));
    expect(r.heads.some(h => h.includes('Участок 1') && h.includes('0/2 готово')) && r.heads.some(h => h.includes('Участок 2') && h.includes('2/3 готово')), 'готово по участкам: ' + JSON.stringify(r.heads));
    expect(r.pdfOver === 1, 'в PDF-отчёте просрочена только работа без галочки: ' + JSON.stringify(r));
    expect(r.fNew === 't1' && r.fProg === 't2,t3' && r.fDone === 't4,t5' && r.fOver === 't2', 'нажатие на счётчик показывает те же работы: ' + JSON.stringify(r));
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Задачи: галочка ставит «Завершено» и 100%, просрочка снимается', async () => {
    const page = await openApp();
    const r = await page.evaluate(async () => {
        const d = n => getFormattedDate(n);
        __db.tasks = [{ id: 'k1', project_id: 'p1', title: 'Газон', category: 'Участок 1', status: 'in_progress', progress: 40, due_date: d(-2) }];
        appData.currentProjectId = 'p1';
        await refreshAllData();
        renderProjectOverview(); renderTasksList();
        const num = id => +document.getElementById(id).innerText;
        const s0 = { over: num('statOverdue'), done: num('statCompleted') };
        await toggleTaskStruck('k1');
        const row = { ...__db.tasks[0] };
        const s1 = { over: num('statOverdue'), done: num('statCompleted'), badge: !!document.querySelector('#tasksContainer .bg-rose-100') };
        await toggleTaskStruck('k1');
        return { s0, s1, row, back: { ...__db.tasks[0] }, s2: { over: num('statOverdue'), done: num('statCompleted') } };
    });
    expect(r.s0.over === 1 && r.s0.done === 0, 'до галочки: ' + JSON.stringify(r.s0));
    expect(r.row.struck === true && r.row.status === 'completed' && r.row.progress === 100, 'в базе после галочки: ' + JSON.stringify(r.row));
    expect(r.s1.over === 0 && r.s1.done === 1 && !r.s1.badge, 'после галочки нет просрочки: ' + JSON.stringify(r.s1));
    expect(r.back.struck === false && r.back.status === 'in_progress' && r.back.progress === 40 && r.s2.over === 1, 'галочку сняли — всё как было: ' + JSON.stringify(r));
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

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
module.exports = { buildCss, openApp, openSchedule, start: async () => { css = buildCss(); const server = await startServer(); baseUrl = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch(); return { server, browser }; } };
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
