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

test('Весь комплект листов: разделы и листы по номерам, разделы свёрнуты, поиск по марке; лист-картинка открывается, на нём рисуются замечания', async () => {
    const page = await openApp();
    await page.evaluate(() => {
        const add = (section, sheet, i) => __db.drawings.push({ id: 'g' + i, project_id: 'p1', section, sheet, file_path: 'p1/g' + i + '.html', revision_date: '2024-11-12', updated_at: '2026-10-17T10:00:00Z' });
        let i = 0;
        ['9.10 Архитектурные решения МАФ. ЦИЛ-1', '9.2 Архитектурные решения МАФ. ЛБ-1. Лежак', '9.36 Архитектурные решения МАФ. КО-1. КО-2. Колесоотбойники', '9.1 План расстановки МАФ']
            .forEach(s => add('9. МАФ: архитектурные решения', s, i++));
        ['10.25 План фундаментов для КО-2', '10.13 План фундаментов для СЛ-2, ДОР-1, ДОР-2, КО-1', '10.2 План фундаментов ворот'].forEach(s => add('10. Фундаменты МАФ', s, i++));
        ['2.10 Разбивочный план МАФ. Часть 3', '2.1 Разбивочный план благоустройства. Часть 1', '2.2 Разбивочный план благоустройства. Часть 2'].forEach(s => add('2. Разбивочные планы', s, i++));
        ['12.1 План освещения', '12.2 План фундаментов освещения'].forEach(s => add('12. Освещение', s, i++));
        // Лист из PDF: только картинка с приближением, без плана для замечаний.
        // Лист из PDF: картинка 40×20 с приближением, без векторного плана.
        const c = document.createElement('canvas'); c.width = 40; c.height = 20;
        const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 40, 20); x.fillStyle = '#000'; x.fillRect(5, 5, 30, 10);
        __files['p1/g2.html'] = `<!doctype html><html><body><div id="v"><img id="img" alt="лист" src="${c.toDataURL('image/jpeg', 0.9)}"></div><div id="tb"><button id="zf">x</button></div></body></html>`;
    });
    await page.click('#navDrawingsBtn');
    await page.waitForFunction(() => document.querySelectorAll('#allDrawingsList details.drawing-group').length >= 5);
    const groups = await page.$$eval('#allDrawingsList details.drawing-group', els => els.map(e => ({ sec: e.dataset.sec, open: e.open, sheets: [...e.querySelectorAll('button .text-sm')].map(x => x.textContent.trim()) })));
    const secs = groups.map(g => g.sec);
    expect(secs.indexOf('2. Разбивочные планы') < secs.indexOf('9. МАФ: архитектурные решения') && secs.indexOf('9. МАФ: архитектурные решения') < secs.indexOf('10. Фундаменты МАФ') && secs.indexOf('10. Фундаменты МАФ') < secs.indexOf('12. Освещение'), 'разделы не по номерам: ' + secs.join(' / '));
    const maf = groups.find(g => g.sec.startsWith('9.')).sheets.map(s => s.split(' ')[0]);
    expect(maf.join(',') === '9.1,9.2,9.10,9.36', 'листы МАФ не по номерам: ' + maf.join(','));
    const fund = groups.find(g => g.sec.startsWith('10.')).sheets.map(s => s.split(' ')[0]);
    expect(fund.join(',') === '10.2,10.13,10.25', 'листы фундаментов не по номерам: ' + fund.join(','));
    expect(groups.every(g => !g.open), 'при большом комплекте разделы должны быть свёрнуты');
    // Раскрытый раздел остаётся раскрытым после перерисовки.
    await page.click('details.drawing-group[data-sec="12. Освещение"] > summary');
    await page.waitForFunction(() => drawingsOpenSections.has('12. Освещение'));
    await page.evaluate(() => drawAllDrawings());
    expect(await page.$eval('details.drawing-group[data-sec="12. Освещение"]', e => e.open), 'раскрытый раздел свернулся после обновления списка');
    // Поиск по марке: только листы с КО-2, разделы раскрыты.
    await page.fill('#drawingsSearch', 'ко-2');
    const found = await page.$$eval('#allDrawingsList details.drawing-group', els => els.map(e => ({ open: e.open, sheets: [...e.querySelectorAll('button .text-sm')].map(x => x.textContent.trim()) })));
    const names = found.flatMap(g => g.sheets);
    expect(names.length === 2 && names.every(n => /КО-2/.test(n)) && found.every(g => g.open), 'поиск «ко-2» нашёл не то: ' + names.join(' / '));
    await page.fill('#drawingsSearch', 'нет такого листа');
    expect((await page.textContent('#allDrawingsList')).includes('Ничего не найдено'), 'нет подсказки, когда поиск ничего не нашёл');
    // Лист-картинка открывается в просмотре, а «Замечания» честно говорят, что рисовать не на чем.
    await page.fill('#drawingsSearch', '9.36');
    await page.click('#allDrawingsList button:has-text("9.36")');
    await page.waitForFunction(() => document.getElementById('drawingViewerLoading').classList.contains('hidden'), null, { timeout: 15000 });
    const frameOk = await page.frameLocator('#drawingViewerFrame').locator('#img').count();
    expect(frameOk === 1, 'лист-картинка не открылся в просмотре');
    // Замечания рисуются поверх картинки листа: план — сама картинка, размер в её точках, скачивается JPEG.
    await page.click('#notesToggleBtn');
    await page.waitForFunction(() => notesState?.plan, null, { timeout: 15000 });
    const plan = await page.evaluate(() => ({ vb: notesState.baseVb, img: !!document.querySelector('#notesPlan image[href^="data:image/jpeg"]'), msg: document.getElementById('notesMsg').classList.contains('hidden') }));
    expect(plan.img && plan.msg && plan.vb.join(',') === '0,0,40,20', 'на листе-картинке нельзя рисовать замечания: ' + JSON.stringify(plan));
    const jpeg = await page.evaluate(async () => (await notesBuildJpeg())?.size || 0);
    expect(jpeg > 1000, 'замечания листа-картинки не скачиваются картинкой');
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
async function openNotes(page, user = { id: 'u1', full_name: 'Грег' }, pick = true) {
    await page.evaluate(async u => {
        currentUserProfile = u;
        appData.drawings = __db.drawings.map(d => ({ ...d }));
        await openDrawingViewer('d1');
        await toggleDrawingNotes();
    }, user);
    await page.waitForFunction(() => notesState?.vb, null, { timeout: 15000 });
    // Сначала открывается список замечаний листа; для проверок рисования открываем первое (или новое).
    if (pick) await page.evaluate(() => notesSets().length ? notesOpenSet(notesSets()[0]) : notesNewSet());
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
    await page.click('#notesListBtn');
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
    await page.click('#notesListBtn');
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

test('Замечания: список скрыт, пока не открыть; фильтр по автору', async () => {
    const page = await openApp();
    await page.evaluate(() => __db.drawing_notes = [
        { id: 'n1', project_id: 'p1', sheet: 'лист 1 тестовый посадочный план', author_id: 'u2', author_name: 'Прораб', kind: 'rect', color: '#dc2626', data: { x: 0, y: 0, w: 5, h: 5 }, text: 'Бордюр', resolved: false, created_at: '2026-10-14T05:00:00Z' },
        { id: 'n2', project_id: 'p1', sheet: 'лист 1 тестовый посадочный план', author_id: 'u1', author_name: 'Грег', kind: 'ellipse', color: '#2563eb', data: { x: 10, y: 10, w: 5, h: 5 }, text: 'Плитка', resolved: false, created_at: '2026-10-14T06:00:00Z' }]);
    await openNotes(page);
    expect(!(await visible(page, '#notesList')), 'список замечаний виден сразу, а должен быть скрыт');
    expect(await page.evaluate(() => document.querySelectorAll('#notesMarks [data-note]').length) === 2, 'на плане не все пометки');
    await page.click('#notesListBtn');
    let text = await page.$eval('#notesList', el => el.innerText);
    expect(await visible(page, '#notesList') && /Бордюр/.test(text) && /Плитка/.test(text), 'список не открылся: ' + text);
    const opts = await page.$$eval('#notesAuthor option', o => o.map(x => x.textContent.trim()));
    expect(JSON.stringify(opts) === JSON.stringify(['Все авторы', 'Грег (я)', 'Прораб']), 'авторы в фильтре: ' + JSON.stringify(opts));
    await page.selectOption('#notesAuthor', 'u2');
    text = await page.$eval('#notesList', el => el.innerText);
    const ids = await page.evaluate(() => [...document.querySelectorAll('#notesMarks [data-note]')].map(e => e.dataset.note));
    expect(JSON.stringify(ids) === '["n1"]' && /Бордюр/.test(text) && !/Плитка/.test(text), 'фильтр по автору не сработал: ' + JSON.stringify(ids) + ' ' + text);
    await page.click('#notesList button[title="Скрыть список"]');
    expect(!(await visible(page, '#notesList')), 'список не скрылся');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Замечания: сначала список замечаний листа, переименование, новое замечание с чистого листа', async () => {
    const page = await openApp();
    const S = 'лист 1 тестовый посадочный план';
    await page.evaluate(S => __db.drawing_notes = [
        { id: 'n1', project_id: 'p1', sheet: S, author_id: 'u1', author_name: 'Грег', kind: 'rect', color: '#dc2626', data: { x: 0, y: 0, w: 5, h: 5 }, text: 'Старая', resolved: false, created_at: '2026-10-14T05:00:00Z' },
        { id: 'n2', project_id: 'p1', sheet: S, author_id: 'u2', author_name: 'Прораб', kind: 'ellipse', color: '#2563eb', data: { x: 10, y: 10, w: 5, h: 5, set: 'Бордюры' }, text: 'Бордюр', resolved: true, created_at: '2026-10-14T06:00:00Z' }], S);
    await openNotes(page, undefined, false);
    // Первым делом — список: «Замечание 1» (всё, что было нарисовано раньше) и «Бордюры».
    expect(await visible(page, '#notesSets'), 'список замечаний не показан');
    let names = await page.$$eval('#notesSets [data-notes-set]', els => els.map(e => e.dataset.notesSet));
    expect(JSON.stringify(names) === '["Замечание 1","Бордюры"]', 'замечания в списке: ' + JSON.stringify(names));
    expect(/Пометок: 1, открытых: 0/.test(await page.$eval('#notesSets [data-notes-set="Бордюры"]', e => e.innerText)), 'нет счётчика пометок');
    // Под замечанием — кто составил и от какого числа (по первой пометке).
    const meta = await page.$eval('#notesSets [data-notes-set="Бордюры"] [data-notes-set-meta]', e => e.textContent.trim());
    expect(meta === 'Составил: Прораб · от 14.10.2026', 'составитель и дата: ' + meta);
    // Чужое замечание переименовать нельзя (не ответственный за чертежи), своё — можно.
    expect(!(await page.$('#notesSets [data-notes-set="Бордюры"] [data-notes-rename]')), 'чужое замечание можно переименовать');
    page.once('dialog', d => d.accept('Плитка у входа'));
    await page.click('#notesSets [data-notes-set="Замечание 1"] [data-notes-rename]');
    await page.waitForFunction(() => __db.drawing_notes.find(r => r.id === 'n1').data.set === 'Плитка у входа');
    names = await page.$$eval('#notesSets [data-notes-set]', els => els.map(e => e.dataset.notesSet));
    expect(JSON.stringify(names) === '["Плитка у входа","Бордюры"]', 'после переименования: ' + JSON.stringify(names));
    // Открываю замечание — на плане только его пометки.
    await page.click('#notesSets [data-notes-set="Бордюры"] button');
    expect(!(await visible(page, '#notesSets')), 'список не закрылся');
    let ids = await page.evaluate(() => [...document.querySelectorAll('#notesMarks [data-note]')].map(e => e.dataset.note));
    expect(JSON.stringify(ids) === '["n2"]', 'на плане пометки другого замечания: ' + JSON.stringify(ids));
    expect(/Бордюры/.test(await page.textContent('#notesBackBtn')), 'в панели нет названия замечания');
    // Назад к списку и новое замечание — чистый лист.
    await page.click('#notesBackBtn');
    await page.click('#notesNewSetBtn');
    expect(await page.evaluate(() => notesState.set) === 'Замечание 3', 'название нового: ' + await page.evaluate(() => notesState.set));
    expect(await page.evaluate(() => document.querySelectorAll('#notesMarks [data-note]').length) === 0, 'новое замечание не с чистого листа');
    const vb = await page.evaluate(() => notesState.vb);
    const P = (fx, fy) => [vb[0] + vb[2] * fx, vb[1] + vb[3] * fy];
    await page.click('#notesToolbar [data-tool="rect"]');
    await notesDrag(page, P(0.3, 0.3), P(0.5, 0.45));
    await page.waitForFunction(() => __db.drawing_notes.length === 3);
    const added = await page.evaluate(() => __db.drawing_notes[2]);
    expect(added.data.set === 'Замечание 3', 'пометка сохранена не в новое замечание: ' + JSON.stringify(added.data));
    // Растягивание и сдвиг не теряют, к какому замечанию относится пометка.
    const kept = await page.evaluate(() => { const m = notesState.marks.find(x => x.data.set === 'Замечание 3'); const b = noteBounds(m);
        return [noteResized(m, b, 'se', [b[2] + 5, b[3] + 5]).set, noteMoved(m, 1, 1).set, noteResized({ kind: 'text', data: { x: 1, y: 1, size: 2, set: 'А' } }, [0, 0, 4, 2], 'e', [8, 1]).set]; });
    expect(kept.join() === 'Замечание 3,Замечание 3,А', 'при изменении размера потерялось замечание: ' + kept.join());
    await page.click('#notesBackBtn');
    names = await page.$$eval('#notesSets [data-notes-set]', els => els.map(e => e.dataset.notesSet));
    expect(JSON.stringify(names) === '["Плитка у входа","Бордюры","Замечание 3"]', 'итоговый список: ' + JSON.stringify(names));
    // Пустое новое замечание, на котором ничего не нарисовали, в списке не остаётся.
    await page.click('#notesNewSetBtn');
    await page.click('#notesBackBtn');
    expect((await page.$$('#notesSets [data-notes-set]')).length === 3, 'пустое замечание осталось в списке');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Замечания: после рисования снова стрелка, растягивание за любую сторону рамки', async () => {
    const page = await openApp({ width: 390, height: 800 });
    await openNotes(page);
    const vb = await page.evaluate(() => notesState.vb);
    const P = (fx, fy) => [vb[0] + vb[2] * fx, vb[1] + vb[3] * fy];
    const W = vb[2], H = vb[3], tol = W * 0.01;
    const note = kind => page.evaluate(k => JSON.parse(JSON.stringify(__db.drawing_notes.find(n => n.kind === k))), kind);
    await page.click('#notesToolbar [data-tool="rect"]');
    await notesDrag(page, P(0.3, 0.3), P(0.6, 0.5));
    await page.waitForFunction(() => __db.drawing_notes.length === 1);
    expect(await page.evaluate(() => notesState.tool) === 'pan', 'после рисования инструмент не вернулся на стрелку');
    // Палец по пустому месту двигает план, а не рисует новую фигуру.
    await notesDrag(page, P(0.8, 0.8), P(0.7, 0.75));
    expect(await page.evaluate(() => __db.drawing_notes.length) === 1, 'второе касание нарисовало новую фигуру');
    // Ручки по всему периметру: 4 угла и 4 середины сторон.
    const hs = await page.evaluate(() => [...new Set([...document.querySelectorAll('#notesDraft [data-handle]')].map(e => e.dataset.handle))].sort());
    expect(JSON.stringify(hs) === JSON.stringify(['e', 'n', 'ne', 'nw', 's', 'se', 'sw', 'w']), 'ручки рамки: ' + JSON.stringify(hs));
    // Тяну левую сторону рамки (не угол, а место на трети высоты) — меняется только ширина.
    const r0 = await note('rect');
    const k = await page.evaluate(() => notesUnitsPerPx());
    await notesDrag(page, [r0.data.x - 10 * k, r0.data.y + r0.data.h / 3], [r0.data.x - W * 0.1, r0.data.y + r0.data.h / 3]);
    const r1 = await note('rect');
    expect(near(r1.data.x + r1.data.w, r0.data.x + r0.data.w, tol) && r1.data.w > r0.data.w + W * 0.07 && near(r1.data.h, r0.data.h, tol) && near(r1.data.y, r0.data.y, tol),
        'левая сторона не растянулась: ' + JSON.stringify([r0.data, r1.data]));
    // Нижняя середина — меняется только высота.
    const s = await page.evaluate(() => { const r = document.querySelector('#notesDraft g[data-handle="s"]').getBBox(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await notesDrag(page, s, [s[0], s[1] + H * 0.1]);
    const r2 = await note('rect');
    expect(r2.data.h > r1.data.h + H * 0.07 && near(r2.data.w, r1.data.w, tol), 'низ не растянулся: ' + JSON.stringify([r1.data, r2.data]));
    // Подпись: после неё тоже стрелка; увеличиваю за левую ручку — правый край стоит на месте.
    page.once('dialog', d => d.accept('Проверить'));
    await page.click('#notesToolbar [data-tool="text"]');
    const [tx, ty] = await notesToScreen(page, ...P(0.4, 0.8));
    await page.mouse.click(tx, ty);
    await page.waitForFunction(() => __db.drawing_notes.length === 2);
    expect(await page.evaluate(() => notesState.tool) === 'pan', 'после подписи инструмент не вернулся на стрелку');
    const b0 = await page.evaluate(() => { const t = notesState.marks.find(m => m.kind === 'text'); return noteBox(t); });
    const t0 = await note('text');
    const w = await page.evaluate(() => { const r = document.querySelector('#notesDraft g[data-handle="w"]').getBBox(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    await notesDrag(page, w, [w[0] - (b0[2] - b0[0]), w[1]]);
    const t1 = await note('text');
    const b1 = await page.evaluate(() => { const t = notesState.marks.find(m => m.kind === 'text'); return noteBox(t); });
    expect(t1.data.size > t0.data.size * 1.6 && near(b1[2], b0[2], (b0[2] - b0[0]) * 0.1), 'подпись не увеличилась за левую сторону: ' + JSON.stringify([t0.data, t1.data, b0, b1]));
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
    // В «Аккаунте» видна версия и есть своя кнопка «Обновить» — на случай, если полоска не появилась.
    expect(await page.$eval('#accountVersion', e => e.textContent) === await page.evaluate(() => window.APP_VERSION), 'в «Аккаунте» не видно версию');
    expect((await page.textContent('#accountVersionNew')).includes('999'), 'в «Аккаунте» не сказано про новую версию');
    let reset = 0;
    await page.exposeFunction('__resetSeen', () => { reset++; });
    await page.evaluate(() => { window.__resetAppFiles = () => window.__resetSeen(); openModal('accountModal'); });
    await page.click('#accountUpdateBtn');
    await page.waitForTimeout(200);
    expect(reset === 1, 'кнопка «Обновить» в «Аккаунте» не сбрасывает файлы');
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

// ---- Вход по отпечатку пальца ----
test('Вход по отпечатку: включается в «Аккаунте», при открытии просит палец, «Войти по паролю» выходит', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(e.message));
    page.on('dialog', d => { page.errors.push('сообщение: ' + d.message()); d.dismiss(); });
    await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, r => r.fulfill({ status: 200, body: '' }));
    await page.route(/vendor\/supabase\.js/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
    await page.route(/vendor\/app\.css/, r => r.fulfill({ contentType: 'text/css', body: css }));
    await page.route(/service-worker\.js/, r => r.fulfill({ contentType: 'application/javascript', body: 'self.addEventListener("install", () => self.skipWaiting());' }));
    // Встроенный в Chromium «телефон с отпечатком»: проверка пальца всегда проходит.
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
    // Отпечаток работает только на имени сайта (не на IP), поэтому здесь localhost.
    const url = baseUrl.replace('127.0.0.1', 'localhost') + '/index.html';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof bioToggle === 'function');
    expect(!(await visible(page, '#bioLock')), 'замок показан, хотя отпечаток не включали');
    await page.evaluate(() => {
        ['authCheckingScreen', 'loginScreen'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
        currentUserProfile = { id: 'u1', full_name: 'Грег', email: 'g@x.ru' }; openModal('accountModal'); return bioRenderOption(); });
    expect(await visible(page, '#bioOption'), 'в «Аккаунте» нет переключателя отпечатка');
    await page.click('#bioToggle');
    await page.waitForFunction(() => !!localStorage.getItem('skkg-bio-lock'));
    expect(await page.isChecked('#bioToggle'), 'переключатель не включился');
    const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
    expect(creds.length === 1, 'отпечаток не зарегистрирован');
    // Открываю приложение заново: сразу замок, отпечаток проходит — замок исчезает.
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Заставка с буквами показывается и при входе по отпечатку: она поверх замка и не пропускает нажатия.
    await page.waitForFunction(() => document.getElementById('splash') && !document.getElementById('bioLock').classList.contains('hidden'), null, { timeout: 5000 });
    expect(await page.$eval('#splash', el => +getComputedStyle(el).zIndex > 2147483000 && getComputedStyle(el).pointerEvents === 'auto'), 'заставка не поверх замка отпечатка');
    expect(await page.$eval('#splash', el => +getComputedStyle(el).opacity) === 1, 'заставка пропала при входе по отпечатку');
    await page.waitForFunction(() => document.getElementById('bioLock').classList.contains('hidden'), null, { timeout: 10000 });
    // Отпечаток не подтверждён — замок остаётся, приложение закрыто.
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /не подтверждён|Не получилось/.test(document.getElementById('bioLockMsg').textContent), null, { timeout: 10000 });
    expect(await visible(page, '#bioLock'), 'без отпечатка приложение открылось');
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
    await page.click('#bioUnlockBtn');
    await page.waitForFunction(() => document.getElementById('bioLock').classList.contains('hidden'), null, { timeout: 5000 });
    // «Войти по паролю»: замок снимается, отпечаток забывается, показывается вход.
    await page.evaluate(() => bioShowLock());
    await page.click('#bioLock button:has-text("Войти по паролю")');
    await page.waitForFunction(() => document.getElementById('bioLock').classList.contains('hidden') && !localStorage.getItem('skkg-bio-lock'));
    // Выключение в «Аккаунте» убирает замок.
    await page.evaluate(() => localStorage.setItem('skkg-bio-lock', JSON.stringify({ id: 'AAAA' })));
    await page.evaluate(() => { ['authCheckingScreen', 'loginScreen'].forEach(id => document.getElementById(id)?.classList.add('hidden')); openModal('accountModal'); return bioRenderOption(); });
    expect(await page.isChecked('#bioToggle'), 'переключатель не показывает, что отпечаток включён');
    await page.click('#bioToggle');
    expect(await page.evaluate(() => localStorage.getItem('skkg-bio-lock')) === null, 'отпечаток не выключился');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

// ---- Заставка при запуске ----
test('Заставка: буквы SKKG проявляются, нажатиям не мешает, держится около 4 секунд и исчезает; отпечаток дорисовывает кольцо', async () => {
    const page = await openApp({ width: 390, height: 844 });
    expect(await page.$('#splash'), 'заставки нет при запуске');
    expect(await page.$eval('#splash .sp-word:not(.sp-shine)', el => el.textContent) === 'SKKG', 'в заставке нет букв SKKG');
    expect(await page.$eval('#splash', el => getComputedStyle(el).pointerEvents) === 'none', 'заставка перехватывает нажатия');
    await page.waitForTimeout(2300);
    expect(await page.$eval('#splash .sp-word span:last-child', el => +getComputedStyle(el).opacity) > 0.9, 'буквы не проявились');
    // Переливание: блик идёт по буквам, есть искры.
    expect(await page.$eval('#splash .sp-shine', el => getComputedStyle(el).animationName === 'splashShine' && getComputedStyle(el).backgroundClip === 'text'), 'буквы не переливаются');
    expect((await page.$$('#splash .sp-spark')).length >= 3, 'нет искр');
    await page.waitForTimeout(1500);
    expect(await page.$eval('#splash', el => +getComputedStyle(el).opacity) === 1, 'заставка пропадает слишком рано — не успеть полюбоваться');
    await page.waitForFunction(() => !document.getElementById('splash'), null, { timeout: 5000 });
    // Успешный отпечаток: вокруг кнопки рисуется кольцо, потом замок гаснет.
    await page.evaluate(() => {
        localStorage.setItem('skkg-bio-lock', JSON.stringify({ id: 'AAAA' }));
        navigator.credentials.get = () => new Promise(r => setTimeout(() => r({}), 100));
        bioShowLock(); bioUnlock();
    });
    expect(await visible(page, '#bioLock .bio-pad'), 'на замке нет круга с отпечатком');
    await page.waitForFunction(() => document.getElementById('bioLock').classList.contains('bio-ok'), null, { timeout: 3000 });
    await page.waitForFunction(() => document.getElementById('bioLock').classList.contains('hidden'), null, { timeout: 3000 });
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Окно входа в стиле заставки: тёмный фон, буквы SKKG, тёмные поля, всё помещается на телефоне', async () => {
    const page = await openApp({ width: 390, height: 780 });
    await page.evaluate(() => { document.getElementById('appRoot').classList.add('hidden'); document.getElementById('loginScreen').classList.remove('hidden'); });
    expect(await page.$eval('#loginScreen', el => el.classList.contains('auth-glow') && /radial-gradient/.test(getComputedStyle(el).backgroundImage)), 'у окна входа нет фона как у заставки');
    expect(await page.$eval('#loginScreen .sp-static', el => el.textContent) === 'SKKG', 'в окне входа нет букв SKKG');
    const bg = await page.$eval('#loginEmail', el => getComputedStyle(el).backgroundColor);
    expect(/rgba\(5, 14, 32/.test(bg), 'поле почты не тёмное: ' + bg);
    await page.fill('#loginEmail', 'a@b.ru');
    expect(await page.$eval('#loginEmail', el => getComputedStyle(el).color) === 'rgb(230, 241, 255)', 'текст в поле почты не светлый');
    for (const sel of ['#loginFormEl', '#signupFormEl']) {
        if (sel === '#signupFormEl') await page.evaluate(() => toggleAuthMode());
        const box = await page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right }; });
        expect(box.l >= 0 && box.r <= 390, sel + ' вылезает за край экрана');
    }
    expect(await page.$eval('#newPasswordScreen', el => el.classList.contains('auth-glow')), 'окно нового пароля не в стиле заставки');
    // Первое окно телефона при запуске (из manifest.json): новое имя и тёмный фон, как у заставки.
    const man = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'manifest.json'), 'utf8'));
    expect(man.name === 'SKKG Pro' && man.short_name === 'SKKG Pro' && man.background_color === '#0b1730', 'в manifest.json старое имя или фон');
    // Крупный значок для первого окна — прозрачный, чтобы до заставки не было никакой картинки.
    const big = man.icons.find(i => i.purpose === 'any' && i.sizes === '512x512');
    const png = require('fs').readFileSync(require('path').join(__dirname, '..', big.src.split('?')[0]));
    expect(png[25] === 6 && require('zlib').inflateSync(png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8)).every((b, i) => i % 2049 === 0 || (i % 2049 - 1) % 4 !== 3 || b === 0), 'значок первого окна не прозрачный');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Звук: мелодия при заставке и при входе, выключается в «Аккаунте»', async () => {
    const page = await openApp({ width: 390, height: 844 });
    expect((await page.evaluate(() => window.__uiSoundLog || [])).includes('intro'), 'при заставке не было звука');
    await page.evaluate(() => { document.getElementById('appRoot').classList.add('hidden'); document.getElementById('loginScreen').classList.remove('hidden'); window.__uiSoundLog = []; sb.auth.signInWithPassword = async () => ({ error: null }); });
    await page.fill('#loginEmail', 'a@b.ru'); await page.fill('#loginPassword', '123456');
    await page.click('#loginFormEl button[type=submit]');
    await page.waitForFunction(() => (window.__uiSoundLog || []).includes('unlock'), null, { timeout: 5000 });
    await page.evaluate(() => { document.getElementById('loginScreen').classList.add('hidden'); currentUserProfile = { id: 'u1' }; openModal('accountModal'); return bioRenderOption(); });
    expect(await page.isChecked('#soundToggle'), 'звук по умолчанию выключен');
    await page.click('#soundToggle');
    expect(await page.evaluate(() => localStorage.getItem('skkg-sound')) === 'off', 'выключение звука не запомнилось');
    await page.evaluate(() => { window.__uiSoundLog = []; return uiSound('unlock'); });
    expect(!(await page.evaluate(() => window.__uiSoundLog.length)), 'звук играет, хотя выключен');
    // Описание приложения сервис-воркер не берёт из памяти, иначе телефон видит старое имя и значок.
    expect(/rel="manifest" href="manifest\.json\?v=\d+"/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8')), 'у manifest.json нет ?v= — телефон может взять старый из памяти браузера');
    expect(!/'manifest\.json',/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'service-worker.js'), 'utf8')), 'manifest.json сохраняется в памяти телефона');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

// ---- Ежедневный отчёт ----
async function openDailyReport(page, profile, role, setup) {
    await page.evaluate(async ({ profile, role, setup }) => {
        currentUserProfile = profile; currentUserRole = role;
        __db.workers = [{ id: 'w1', name: 'Иванов', group_name: 'Данияр' }, { id: 'w2', name: 'Петров', group_name: 'Руслан' }, { id: 'w3', name: 'Сидоров', group_name: 'Данияр' }, { id: 'w4', name: 'Козлов', group_name: 'Данияр' }];
        __db.timesheet_entries = [
            { id: 'e1', project_id: 'p1', worker_id: 'w1', work_date: '2026-10-16', status: 'full', hours: 8 },
            { id: 'e2', project_id: 'p1', worker_id: 'w2', work_date: '2026-10-16', status: 'full', hours: 8 },
            { id: 'e3', project_id: 'p1', worker_id: 'w3', work_date: '2026-10-16', status: 'full', hours: 8 },
            { id: 'e4', project_id: 'p1', worker_id: 'w4', work_date: '2026-10-16', status: 'absent', hours: 0 },
            { id: 'e5', project_id: 'p1', worker_id: 'w2', work_date: '2026-10-15', status: 'full', hours: 8 }];
        if (setup) new Function(setup)();
        appData.workers = __db.workers.map(w => ({ id: w.id, name: w.name, groupName: w.group_name }));
        appData.currentProjectId = 'p1';
        applyRoleUI(role);
        ['boardsScreen', 'volumesScreen', 'scheduleScreen'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
        document.getElementById('projectView').classList.remove('hidden');
        dailyReport.date = '2026-10-16'; dailyReport.author = '';
        await renderDailyReport('p1');
    }, { profile, role, setup: setup || '' });
}
test('Ежедневный отчёт: люди по бригадам из табеля, техника, заметки; у каждого свой', async () => {
    const page = await openApp();
    await openDailyReport(page, { id: 'u5', full_name: 'Данияр', role: 'worker', brigade: null }, 'worker');
    expect(await visible(page, '#dailyReportSection'), 'раздела «Ежедневный отчёт» не видно сотруднику');
    let crews = await page.$eval('#dailyReportCrews', e => e.innerText.replace(/\s+/g, ' ').trim());
    expect(/Данияр 2 чел\./.test(crews) && /Руслан 1 чел\./.test(crews) && /Всего 3 чел\./.test(crews), 'люди из табеля (неявка не считается): ' + crews);
    await page.click('#dailyReportAddMachine');
    await page.fill('#dailyReportMachines [data-machine="0"] input', 'Мини-погрузчик');
    await page.fill('#dailyReportMachines [data-machine="0"] input[title="Часов"]', '6');
    await page.fill('#dailyReportNotes', 'Уложили плитку у входа');
    await page.click('#dailyReportSave');
    await page.waitForFunction(() => __db.daily_reports?.length === 1);
    const saved = await page.evaluate(() => __db.daily_reports[0]);
    expect(saved.author_id === 'u5' && saved.report_date === '2026-10-16' && saved.notes === 'Уложили плитку у входа', 'отчёт сохранён неверно: ' + JSON.stringify(saved));
    expect(JSON.stringify(saved.machines) === '[{"name":"Мини-погрузчик","count":1,"hours":6}]' && saved.crews.length === 2, 'техника или люди: ' + JSON.stringify(saved));
    expect(/Сохранён/.test(await page.textContent('#dailyReportStatus')), 'нет отметки «Сохранён»');
    // Повторное сохранение того же дня не создаёт второй отчёт.
    await page.fill('#dailyReportNotes', 'Уложили плитку у входа, завтра бордюр');
    await page.click('#dailyReportSave');
    await page.waitForFunction(() => __db.daily_reports[0].notes.includes('бордюр'));
    expect(await page.evaluate(() => __db.daily_reports.length) === 1, 'второй отчёт за тот же день');
    // Другой день — чистая форма, люди за тот день.
    await page.click('button[title="Предыдущий день"]');
    await page.waitForFunction(() => document.getElementById('dailyReportDate').value === '2026-10-15');
    await page.waitForFunction(() => /Всего 1 чел/.test(document.getElementById('dailyReportCrews')?.innerText.replace(/\s+/g, ' ') || ''));
    expect(await page.$eval('#dailyReportNotes', e => e.value) === '', 'за другой день подставились чужие заметки');
    // Сотрудник со своей бригадой видит в отчёте только её.
    const p2 = await openApp({ width: 390, height: 800 });
    await openDailyReport(p2, { id: 'u6', full_name: 'Руслан', role: 'worker', brigade: 'Руслан' }, 'worker');
    await p2.click('#dailyReportAddMachine');
    const fits = await p2.$eval('#dailyReportSection', e => [...e.querySelectorAll('*')].every(x => x.getBoundingClientRect().right <= e.getBoundingClientRect().right + 1));
    expect(fits, 'на телефоне отчёт не помещается по ширине');
    crews = await p2.$eval('#dailyReportCrews', e => e.innerText.replace(/\s+/g, ' ').trim());
    expect(crews === 'Руслан 1 чел. Всего 1 чел.', 'бригадир видит чужие бригады: ' + crews);
    expect(!(await p2.$('#dailyReportAuthor')), 'сотрудник может открывать чужие отчёты');
    // Руководитель: свой отчёт пустой, но может открыть отчёт Данияра (только просмотр).
    const p3 = await openApp();
    await openDailyReport(p3, { id: 'u1', full_name: 'Грег', role: 'manager' }, 'manager',
        "__db.daily_reports = [{ id: 'r1', project_id: 'p1', author_id: 'u5', author_name: 'Данияр', report_date: '2026-10-16', crews: [{ brigade: 'Данияр', people: 2 }], machines: [{ name: 'Каток', count: 1, hours: 4 }], notes: 'Укатали щебень' }];");
    expect(await p3.$eval('#dailyReportNotes', e => e.value) === '', 'у руководителя не свой отчёт');
    await p3.selectOption('#dailyReportAuthor', 'u5');
    await p3.waitForFunction(() => /Укатали щебень/.test(document.getElementById('dailyReportBody').innerText));
    const other = await p3.$eval('#dailyReportBody', e => e.innerText);
    expect(/Каток — 1 шт, 4 ч/.test(other) && /Данияр 2 чел/.test(other.replace(/\s+/g, ' ')) && !(await p3.$('#dailyReportSave')), 'чужой отчёт: ' + other);
    expect(!page.errors.length && !p2.errors.length && !p3.errors.length, 'ошибки на странице: ' + [...page.errors, ...p2.errors, ...p3.errors].join('; '));
});

test('Ежедневный отчёт: без таблицы в базе — понятная подсказка, а не ошибка', async () => {
    const page = await openApp();
    await openDailyReport(page, { id: 'u1', full_name: 'Грег', role: 'manager' }, 'manager', "__missingTables.push('daily_reports');");
    expect(/supabase\/daily_reports\.sql/.test(await page.textContent('#dailyReportBody')), 'нет подсказки про таблицу');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

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

// Табель с двумя бригадами: «Данияр» и «Руслан».
async function openTimesheet(page, profile) {
    await page.evaluate(async profile => {
        currentUserProfile = profile;
        __db.workers = [{ id: 'w1', name: 'Иванов Иван', role: 'Монтажник', group_name: 'Данияр' }, { id: 'w2', name: 'Петров Пётр', role: 'Монтажник', group_name: 'Руслан' },
            { id: 'w3', name: 'Сидоров Сидор', role: 'Монтажник', group_name: 'Данияр' }];
        __db.project_workers = [{ id: 'r1', project_id: 'p1', worker_id: 'w1' }, { id: 'r2', project_id: 'p1', worker_id: 'w2' }];
        __db.timesheet_entries = [];
        appData.currentProjectId = 'p1';
        await refreshAllData();
        await openProject('p1');
        await renderTimesheetSection('p1');
    }, profile);
}
const tsCell = (page, wid, day) => page.evaluate(([wid, day]) => {
    const d = ymd(timesheetViewDate.getFullYear(), timesheetViewDate.getMonth(), day);
    const el = document.querySelector(`[data-ts-cell="${wid}_${d}"]`);
    return { exists: !!el, clickable: !!el?.getAttribute('onclick'), d };
}, [wid, day]);

test('Табель: бригадир видит все бригады, а отмечает только свою', async () => {
    const page = await openApp({ role: 'worker' });
    await openTimesheet(page, { id: 'u5', full_name: 'Данияр', role: 'worker', staff_role: 'brigadier', brigade: 'Данияр' });
    const own = await tsCell(page, 'w1', 3), other = await tsCell(page, 'w2', 3);
    expect(own.exists && other.exists, 'видны не все бригады');
    expect(own.clickable && !other.clickable, 'отмечать можно не только свою бригаду: ' + JSON.stringify({ own, other }));
    await page.evaluate(d => { document.querySelector(`[data-ts-cell="w1_${d}"]`).click(); }, own.d);
    await page.waitForFunction(() => __db.timesheet_entries.length === 1);
    await page.evaluate(d => toggleTimesheetCell('p1', 'w2', d), other.d);
    expect(await page.evaluate(() => __db.timesheet_entries.map(e => e.worker_id).join()) === 'w1', 'отметилась чужая бригада');
    // Добавить в табель можно только людей своей бригады, новый сотрудник — сразу в свою бригаду.
    const opts = await page.$$eval('#timesheetAddWorkerSelect option', o => o.map(x => x.value).filter(Boolean));
    expect(JSON.stringify(opts) === '["w3"]', 'в списке «добавить» чужие люди: ' + JSON.stringify(opts));
    expect(await page.$eval('#timesheetNewWorkerGroup', i => i.readOnly && i.value === 'Данияр'), 'бригада нового сотрудника не своя');
    expect(/только свою бригаду «Данияр»/.test(await page.$eval('#timesheetBrigadeNote', e => e.innerText)), 'нет подсказки про свою бригаду');
    // Меню «Ещё» сотрудникам и бригадирам не показывается.
    expect(!(await visible(page, '#navMoreBtn')), 'у сотрудника видно «Ещё»');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Табель: сотрудник без своей бригады отмечает всех, как раньше; руководитель и прораб — всех', async () => {
    const worker = await openApp({ role: 'worker' });
    await openTimesheet(worker, { id: 'u6', full_name: 'Новичок', role: 'worker', brigade: null });
    expect((await tsCell(worker, 'w1', 3)).clickable && (await tsCell(worker, 'w2', 3)).clickable, 'без бригады нельзя отмечать');
    expect(await visible(worker, '#timesheetEditTools'), 'без бригады не видно «Новый сотрудник»');
    expect(!(await visible(worker, '#timesheetBrigadeNote')), 'лишняя подсказка про бригаду');
    for (const [role, profile] of [['manager', { id: 'u1', full_name: 'Грег', role: 'manager' }], ['lead', { id: 'u7', full_name: 'Прораб', role: 'lead', staff_role: 'foreman' }]]) {
        const page = await openApp({ role });
        await openTimesheet(page, profile);
        expect((await tsCell(page, 'w1', 3)).clickable && (await tsCell(page, 'w2', 3)).clickable, role + ' не может отмечать все бригады');
        expect(await visible(page, '#navMoreBtn'), role + ': нет меню «Ещё»');
        expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
    }
    expect(!worker.errors.length, 'ошибки на странице: ' + worker.errors.join('; '));
});

test('Работа в списке: процент сверху, «⋯» с меню «Удалить», синяя галочка справа', async () => {
    const page = await openApp();
    await page.evaluate(async () => {
        __db.tasks = [{ id: 't1', project_id: 'p1', title: 'Укладка плитки', category: 'Участок 1', status: 'in_progress', progress: 40 }];
        appData.currentProjectId = 'p1';
        await refreshAllData();
        await openProject('p1');
    });
    const geo = await page.evaluate(() => {
        const row = document.querySelector('#tasksContainer .task-row'), b = el => el.getBoundingClientRect();
        const title = [...row.querySelectorAll('div')].find(d => d.textContent.trim() === 'Укладка плитки');
        const check = row.querySelector('button[title="Отметить работу как выполненную"]');
        return { pct: b(row.querySelector('.task-pct')).bottom, pctText: row.querySelector('.task-pct').textContent, title: b(title).top, titleRight: b(title).right, check: b(check).left };
    });
    expect(geo.pct <= geo.title && geo.pctText === '40%', 'процент не над работой: ' + JSON.stringify(geo));
    expect(geo.check > geo.titleRight, 'галочка не справа: ' + JSON.stringify(geo));
    // Полоса процентов как на образце: тонкая (5 px), тёмно-серая на светло-сером фоне.
    const bar = await page.$eval('#tasksContainer .task-bar', el => ({ h: el.getBoundingClientRect().height, fill: getComputedStyle(el.firstElementChild).backgroundColor, w: el.firstElementChild.style.width }));
    expect(bar.h === 5 && bar.fill === 'rgb(42, 42, 42)' && bar.w === '40%', 'полоса процентов: ' + JSON.stringify(bar));
    expect(!(await visible(page, '#taskMenu')), 'меню открыто без нажатия');
    await page.hover('#tasksContainer .task-row');
    await page.click('#tasksContainer .task-more');
    expect(await visible(page, '#taskMenu') && /Удалить/.test(await page.$eval('#taskMenu', e => e.innerText)), 'по «⋯» нет меню с «Удалить»');
    expect(!(await visible(page, '#taskModal')), 'нажатие на «⋯» открыло редактирование');
    page.once('dialog', d => d.accept());
    await page.click('#taskMenu >> text=Удалить');
    await page.waitForFunction(() => __db.tasks.length === 0);
    // Галочка синяя.
    await page.evaluate(async () => { __db.tasks = [{ id: 't2', project_id: 'p1', title: 'Газон', category: 'Участок 1', status: 'new', progress: 0 }]; await refreshAllData(); renderTasksList(); });
    await page.click('#tasksContainer button[title="Отметить работу как выполненную"]');
    await page.waitForFunction(() => __db.tasks[0].struck === true);
    const bg = await page.$eval('#tasksContainer button[title="Отметить работу как выполненную"]', el => getComputedStyle(el).backgroundColor);
    expect(bg === 'rgb(37, 99, 235)', 'отмеченная галочка не синяя: ' + bg);
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Свои списки работ: у сотрудника свой, руководитель открывает список любого', async () => {
    const tasks = [
        { id: 'g1', project_id: 'p1', title: 'Работа Грега', category: 'Участок 1', status: 'new', progress: 0, owner_id: null },
        { id: 'd1', project_id: 'p1', title: 'Работа Данияра', category: 'Участок 1', status: 'new', progress: 0, owner_id: 'u5' },
        { id: 'r1', project_id: 'p1', title: 'Работа Руслана', category: 'Участок 2', status: 'new', progress: 0, owner_id: 'u8' }];
    const people = [{ id: 'u1', full_name: 'Грег', role: 'manager' }, { id: 'u5', full_name: 'Данияр', role: 'worker', staff_role: 'brigadier', brigade: 'Данияр' },
        { id: 'u8', full_name: 'Руслан', role: 'lead', staff_role: 'foreman' }, { id: 'u9', full_name: 'Заказчик', role: 'customer' }];
    const shown = page => page.evaluate(() => [...document.querySelectorAll('#tasksContainer')].map(e => e.innerText).join(' '));
    const open = async (role, me) => {
        const page = await openApp({ role });
        await page.evaluate(async ({ tasks, people, me }) => {
            __db.tasks = tasks.map(t => ({ ...t })); __db.profiles = people;
            currentUserProfile = people.find(p => p.id === me);
            appData.currentProjectId = 'p1';
            await refreshAllData();
            await openProject('p1');
        }, { tasks, people, me });
        return page;
    };
    // Бригадир видит только свой список; новая работа — в его список.
    const dan = await open('worker', 'u5');
    let text = await shown(dan);
    expect(/Работа Данияра/.test(text) && !/Работа Грега/.test(text) && !/Работа Руслана/.test(text), 'бригадир видит чужие работы: ' + text);
    expect(!(await visible(dan, '#taskDeskWrap')), 'бригадиру виден выбор чужих списков');
    await dan.evaluate(async () => {
        openAddTaskModal();
        document.getElementById('taskTitle').value = 'Новая работа бригадира';
        await saveTask(new Event('submit'));
    });
    await dan.waitForFunction(() => __db.tasks.some(t => t.title === 'Новая работа бригадира'));
    expect(await dan.evaluate(() => __db.tasks.find(t => t.title === 'Новая работа бригадира').owner_id) === 'u5', 'новая работа бригадира не в его списке');
    // Руководитель: свой список как раньше, выбор людей с должностями, в чужом списке работает как в своём.
    const greg = await open('manager', 'u1');
    text = await shown(greg);
    expect(/Работа Грега/.test(text) && !/Работа Данияра/.test(text), 'список руководителя не свой: ' + text);
    const opts = await greg.$$eval('#taskDeskSelect option', o => o.map(x => x.textContent.trim()));
    expect(opts[0] === 'Мой список работ' && opts.some(o => /Руслан · Прораб/.test(o)) && opts.some(o => /Данияр · Бригадир/.test(o)) && !opts.some(o => /Заказчик/.test(o)),
        'выбор списков: ' + JSON.stringify(opts));
    await greg.selectOption('#taskDeskSelect', 'u5');
    text = await shown(greg);
    expect(/Работа Данияра/.test(text) && !/Работа Грега/.test(text), 'в списке Данияра не его работы: ' + text);
    expect(await visible(greg, '#taskDeskBanner') && /Данияр · Бригадир/.test(await greg.$eval('#taskDeskBanner', e => e.innerText)), 'не видно, чей список открыт');
    await greg.evaluate(async () => {
        openAddTaskModal();
        document.getElementById('taskTitle').value = 'Задание от Грега';
        await saveTask(new Event('submit'));
    });
    await greg.waitForFunction(() => __db.tasks.some(t => t.title === 'Задание от Грега'));
    expect(await greg.evaluate(() => __db.tasks.find(t => t.title === 'Задание от Грега').owner_id) === 'u5', 'работа из чужого списка ушла не туда');
    await greg.click('#taskDeskBanner button');
    text = await shown(greg);
    expect(/Работа Грега/.test(text) && !/Задание от Грега/.test(text), 'не вернулся к своему списку: ' + text);
    expect(!dan.errors.length && !greg.errors.length, 'ошибки на странице: ' + dan.errors.concat(greg.errors).join('; '));
});

test('Задания бригадиру: видны у него, сроки и закрытие только у руководителя', async () => {
    const tasks = [
        { id: 'a1', project_id: 'p1', worker_id: 'w5', title: 'Укладка плитки', category: 'Участок 1', status: 'new', progress: 0, start_date: '2026-10-10', due_date: '2026-10-20', owner_id: null },
        { id: 'a2', project_id: 'p1', worker_id: 'w9', title: 'Чужая работа', category: 'Участок 1', status: 'new', progress: 0, owner_id: null },
        { id: 'a3', project_id: 'p1', worker_id: 'w5', title: 'Своя работа Данияра', category: 'Участок 2', status: 'new', progress: 0, start_date: '2026-10-10', due_date: '2026-10-20', owner_id: 'u5' }];
    const people = [{ id: 'u1', full_name: 'Грег', role: 'manager' }, { id: 'u5', full_name: 'Данияр', role: 'worker', staff_role: 'brigadier', worker_id: 'w5' }];
    const open = async (role, me) => {
        const page = await openApp({ role });
        await page.evaluate(async ({ tasks, people, me }) => {
            __db.tasks = tasks.map(t => ({ ...t })); __db.profiles = people;
            __db.workers = [{ id: 'w5', name: 'Данияр Б.', role: 'Бригадир' }, { id: 'w9', name: 'Руслан Р.', role: 'Бригадир' }];
            currentUserProfile = people.find(p => p.id === me);
            appData.currentProjectId = 'p1';
            await refreshAllData();
            await openProject('p1');
        }, { tasks, people, me });
        return page;
    };
    const dan = await open('worker', 'u5');
    const text = await dan.$eval('#tasksContainer', e => e.innerText);
    expect(/Укладка плитки/.test(text) && /Своя работа Данияра/.test(text) && !/Чужая работа/.test(text), 'у бригадира не те работы: ' + text);
    expect(/Задание от руководителя/.test(text), 'не отмечено, что это задание руководителя');
    // Галочки на задании нет, статус «Завершено» не выставить, сроки не менять.
    const row = await dan.evaluate(() => {
        const r = [...document.querySelectorAll('#tasksContainer .task-row')].find(x => x.innerText.includes('Укладка плитки'));
        return { check: !!r.querySelector('button[title="Отметить работу как выполненную"]'), del: !!r.querySelector('button[title="Удалить"]'), drag: r.getAttribute('draggable') };
    });
    expect(!row.check && !row.del && row.drag !== 'true', 'бригадир может закрыть, удалить или перетащить задание: ' + JSON.stringify(row));
    await dan.evaluate(async () => { await toggleTaskStruck('a1'); for (let i = 0; i < 5; i++) await cycleTaskStatus('a1'); });
    expect(await dan.evaluate(() => __db.tasks[0].status !== 'completed' && !__db.tasks[0].struck), 'бригадир закрыл задание');
    await dan.evaluate(() => editTask('a1'));
    const form = await dan.evaluate(() => ({ start: taskStartDate.disabled, due: taskDueDate.disabled, worker: taskWorkerId.disabled,
        done: [...taskStatus.options].find(o => o.value === 'completed').disabled, hint: taskAssignmentHint.innerText }));
    expect(form.start && form.due && form.worker && form.done && /сроки/.test(form.hint), 'в форме задания можно менять сроки или закрыть: ' + JSON.stringify(form));
    await dan.evaluate(async () => {
        taskTitle.value = 'Укладка плитки, секция 2'; taskStatus.value = 'review'; document.getElementById('taskProgress').value = 100;
        taskDueDate.value = '2026-12-31';
        await saveTask(new Event('submit'));
    });
    const a1 = await dan.evaluate(() => ({ ...__db.tasks.find(t => t.id === 'a1') }));
    expect(a1.title === 'Укладка плитки, секция 2' && a1.status === 'review' && a1.progress === 100 && a1.due_date === '2026-10-20' && a1.worker_id === 'w5',
        'бригадир сохранил не то: ' + JSON.stringify(a1));
    // Своя работа бригадира — полностью его: может закрыть галочкой.
    await dan.evaluate(() => toggleTaskStruck('a3'));
    expect(await dan.evaluate(() => __db.tasks.find(t => t.id === 'a3').struck === true), 'бригадир не может закрыть свою работу');
    // Руководитель: в списке Данияра видит задание и его работы; новое задание из его списка — своё, на Данияра.
    const greg = await open('manager', 'u1');
    await greg.selectOption('#taskDeskSelect', 'u5');
    const gt = await greg.$eval('#tasksContainer', e => e.innerText);
    expect(/Укладка плитки/.test(gt) && /Своя работа Данияра/.test(gt) && !/Чужая работа/.test(gt), 'список Данияра у руководителя: ' + gt);
    expect(/ваше задание ему/.test(await greg.$eval('#taskDeskBanner', e => e.innerText)), 'не сказано, что работы будут заданиями');
    await greg.evaluate(async () => { openAddTaskModal(); taskTitle.value = 'Бордюр'; await saveTask(new Event('submit')); });
    await greg.waitForFunction(() => __db.tasks.some(t => t.title === 'Бордюр'));
    const b = await greg.evaluate(() => ({ ...__db.tasks.find(t => t.title === 'Бордюр') }));
    expect(b.owner_id === null && b.worker_id === 'w5', 'задание руководителя создано не так: ' + JSON.stringify(b));
    // Руководитель закрывает задание галочкой.
    await greg.evaluate(() => toggleTaskStruck('a1'));
    expect(await greg.evaluate(() => __db.tasks.find(t => t.id === 'a1').status === 'completed'), 'руководитель не закрыл задание');
    expect(!dan.errors.length && !greg.errors.length, 'ошибки на странице: ' + dan.errors.concat(greg.errors).join('; '));
});

test('Пользователи и роли: бригада и связь с сотрудником подбираются по имени', async () => {
    const page = await openApp();
    const p = await page.evaluate(async () => {
        __db.profiles = [
            { id: 'u5', full_name: 'Данияр', email: 'd@x.ru', role: 'worker', staff_role: 'brigadier', brigade: null, worker_id: null },
            { id: 'u6', full_name: 'Руслан Петров', email: 'r@x.ru', role: 'worker', staff_role: null, brigade: null, worker_id: null },
            { id: 'u7', full_name: 'Алексей', email: 'a@x.ru', role: 'worker', staff_role: null, brigade: null, worker_id: null },
            { id: 'u8', full_name: 'Иван Сидоров', email: 'i@x.ru', role: 'lead', staff_role: 'foreman', brigade: null, worker_id: null }];
        __db.project_members = [];
        appData.workers = [{ id: 'w1', name: 'Данияр Б.', groupName: 'Бригадиры' }, { id: 'w2', name: 'Иванов Иван', groupName: 'Данияр' },
            { id: 'w3', name: 'Петров Руслан', groupName: 'Руслан' }, { id: 'w4', name: 'Алексей К.', groupName: 'Данияр' }, { id: 'w5', name: 'Алексей М.', groupName: 'Руслан' },
            { id: 'w6', name: 'Сидоров Иван', groupName: 'ИТР' }];
        await openUsersModal();
        return __db.profiles.map(x => [x.id, x.worker_id, x.brigade]);
    });
    expect(JSON.stringify(p) === JSON.stringify([['u5', 'w1', 'Данияр'], ['u6', 'w3', 'Руслан'], ['u7', null, null], ['u8', 'w6', null]]),
        'подобрано неверно (два Алексея — не угадываем, прорабу бригада не нужна): ' + JSON.stringify(p));
    expect(/подобрано по имени/.test(await page.$eval('#usersListContainer', e => e.innerText)), 'не видно, что подобрано автоматически');
    // Выбрал связь вручную — бригада подставилась по имени, если её не было.
    await page.selectOption('[data-user-worker="u7"]', 'w5');
    await page.waitForFunction(() => __db.profiles[2].worker_id === 'w5');
    expect(await page.evaluate(() => __db.profiles[2].brigade) === 'Руслан', 'бригада не подставилась по выбранному сотруднику');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Без обновления базы «Пользователи и роли» как раньше: без бригад и должностей', async () => {
    const page = await openApp();
    await page.evaluate(async () => {
        __db.profiles = [{ id: 'u5', full_name: 'Данияр', email: 'd@x.ru', role: 'worker' }];
        __db.project_members = [];
        appData.workers = [{ id: 'w1', name: 'Данияр Б.', groupName: 'Данияр' }];
        await openUsersModal();
    });
    const roles = await page.$$eval('[data-user-role="u5"] option', o => o.map(x => x.textContent.trim()));
    expect(!roles.includes('Бригадир') && !roles.includes('Прораб') && roles.includes('Сотрудник'), 'должности видны без обновления базы: ' + JSON.stringify(roles));
    expect(!(await page.$('[data-user-brigade="u5"]')) && !(await page.$('[data-user-worker="u5"]')), 'настройки бригады видны без обновления базы');
    expect(await page.evaluate(() => JSON.stringify(__db.profiles[0])) === JSON.stringify({ id: 'u5', full_name: 'Данияр', email: 'd@x.ru', role: 'worker' }), 'профиль изменился');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Бригада подбирается сама при входе руководителя, без «Пользователи и роли»', async () => {
    const page = await openApp();
    const p = await page.evaluate(async () => {
        currentUserProfile = { id: 'u1', full_name: 'Грег', role: 'manager' };
        __db.profiles = [currentUserProfile, { id: 'u5', full_name: 'Данияр', role: 'worker', staff_role: null, brigade: null, worker_id: null }];
        __db.workers = [{ id: 'w1', name: 'Данияр Б.', group_name: 'Бригадиры' }, { id: 'w2', name: 'Иванов Иван', group_name: 'Данияр' }];
        await refreshAllData();
        return __db.profiles[1];
    });
    expect(p.worker_id === 'w1' && p.brigade === 'Данияр', 'не подобралось при входе: ' + JSON.stringify(p));
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('Пользователи и роли: Бригадир и Прораб, бригада для табеля', async () => {
    const page = await openApp();
    await page.evaluate(async () => {
        __db.profiles = [{ id: 'u5', full_name: 'Данияр', email: 'd@x.ru', role: 'worker', staff_role: null, brigade: null }, { id: 'u8', full_name: 'Руслан', email: 'r@x.ru', role: 'worker', staff_role: null, brigade: null }];
        __db.project_members = [];
        appData.workers = [{ id: 'w1', name: 'Иванов', groupName: 'Данияр' }, { id: 'w2', name: 'Петров', groupName: 'Руслан' }];
        await openUsersModal();
    });
    const roles = await page.$$eval('[data-user-role="u5"] option', o => o.map(x => x.textContent.trim()));
    expect(roles.includes('Бригадир') && roles.includes('Прораб'), 'нет должностей: ' + JSON.stringify(roles));
    await page.selectOption('[data-user-role="u5"]', 'brigadier');
    await page.waitForFunction(() => __db.profiles[0].staff_role === 'brigadier');
    await page.selectOption('[data-user-brigade="u5"]', 'Данияр');
    await page.waitForFunction(() => __db.profiles[0].brigade === 'Данияр');
    await page.selectOption('[data-user-role="u8"]', 'foreman');
    await page.waitForFunction(() => __db.profiles[1].staff_role === 'foreman');
    const p = await page.evaluate(() => __db.profiles.map(x => [x.role, x.staff_role, x.brigade || null]));
    expect(JSON.stringify(p) === JSON.stringify([['worker', 'brigadier', 'Данияр'], ['lead', 'foreman', 'Руслан']]), 'в базе: ' + JSON.stringify(p));
    expect(!(await page.$('[data-user-brigade="u8"]')), 'у прораба выбор бригады (он отмечает все)');
    // Обратно в «Сотрудник» — должность снимается.
    await page.selectOption('[data-user-role="u5"]', 'worker');
    await page.waitForFunction(() => __db.profiles[0].staff_role === null);
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

// ---- Вход без VPN: база через наш сайт ----
test('Без VPN база недоступна — запросы идут через skkg.ru (sb.php), с VPN — снова напрямую', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let blocked = true;
    const proxied = [];
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => blocked ? r.abort('connectionrefused') : r.fulfill({ status: 200, contentType: 'application/json', body: '{"direct":true}' }));
    await page.route(/vendor\/supabase\.js/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
    await page.route(/service-worker\.js/, r => r.fulfill({ contentType: 'application/javascript', body: 'self.addEventListener("install", () => self.skipWaiting());' }));
    await page.route(/sb\.php/, r => {
        proxied.push({ url: r.request().url(), auth: r.request().headers()['x-sb-authorization'], method: r.request().method(), body: r.request().postData() });
        r.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Sb-Proxy': '1' }, body: '{"proxy":true}' });
    });
    await page.goto(baseUrl + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof sbFetch === 'function');
    const res = await page.evaluate(async () => {
        const r = await sbFetch(SUPABASE_URL + '/rest/v1/tasks?select=*&id=eq.5', { method: 'POST', headers: { Authorization: 'Bearer tok', apikey: 'k' }, body: '{"a":1}' });
        return { body: await r.json(), flag: localStorage.getItem('skkg-db-route'), link: sbUrl(SUPABASE_URL + '/storage/v1/object/sign/f/a.pdf?token=x') };
    });
    expect(res.body.proxy, 'при заблокированной базе запрос не пошёл через sb.php');
    expect(res.flag === 'proxy', 'обход не запомнился на устройстве');
    const last = proxied[proxied.length - 1];
    expect(decodeURIComponent(last.url.split('u=')[1]) === '/rest/v1/tasks?select=*&id=eq.5', 'путь к базе передан неверно: ' + last.url);
    expect(last.auth === 'Bearer tok' && last.method === 'POST' && last.body === '{"a":1}', 'вход (Authorization), метод или данные не переданы через sb.php');
    expect(res.link.startsWith('sb.php?u=') && decodeURIComponent(res.link.split('u=')[1]) === '/storage/v1/object/sign/f/a.pdf?token=x', 'ссылка на файл не идёт через наш сайт: ' + res.link);
    // Следующее открытие сразу идёт через наш сайт, без ожидания.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof sbFetch === 'function');
    const n = proxied.length;
    expect((await page.evaluate(async () => (await (await sbFetch(SUPABASE_URL + '/rest/v1/x')).json()).proxy)), 'после повторного открытия запрос не через sb.php');
    expect(proxied.length > n, 'sb.php не вызван');
    // Включили VPN — приложение само возвращается к прямой связи.
    blocked = false;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof sbFetch === 'function' && !sbRoute.proxy, null, { timeout: 8000 });
    expect((await page.evaluate(async () => (await (await sbFetch(SUPABASE_URL + '/rest/v1/x')).json()).direct)), 'с VPN запрос не идёт напрямую');
    expect(await page.evaluate(() => localStorage.getItem('skkg-db-route') === null), 'отметка обхода не снялась');
});

test('Хостинг без PHP: sb.php не работает — понятная ошибка, а с VPN всё напрямую', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let blocked = true;
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => blocked ? r.abort('connectionrefused') : r.fulfill({ status: 200, contentType: 'application/json', body: '{"direct":true}' }));
    await page.route(/vendor\/supabase\.js/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
    await page.route(/service-worker\.js/, r => r.fulfill({ contentType: 'application/javascript', body: 'self.addEventListener("install", () => self.skipWaiting());' }));
    // Так отвечает хостинг, где PHP не включён: отдаёт сам файл, а на POST — свою страницу ошибки.
    await page.route(/sb\.php/, r => r.request().method() === 'GET'
        ? r.fulfill({ status: 200, contentType: 'application/octet-stream', body: '<?php // ...' })
        : r.fulfill({ status: 405, contentType: 'text/html', body: '<html><head><title>405 Not Allowed</title></head></html>' }));
    await page.goto(baseUrl + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof sbFetch === 'function');
    const res = await page.evaluate(async () => {
        const out = [];
        for (const m of ['GET', 'POST']) {
            try { await sbFetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', { method: m, body: m === 'POST' ? '{}' : undefined }); out.push('ok'); }
            catch (e) { out.push(e instanceof TypeError ? 'net' : 'other:' + e.message); }
        }
        return { out, flag: localStorage.getItem('skkg-db-route') };
    });
    expect(res.out.join() === 'net,net', 'ожидалась ошибка связи, а не страница хостинга: ' + res.out.join());
    expect(res.flag === null, 'неработающий обход запомнился на телефоне');
    // Отметка обхода осталась с прошлого раза, а сейчас включён VPN: запросы всё равно доходят напрямую.
    blocked = false;
    await page.evaluate(() => { sbRoute.proxy = true; localStorage.setItem('skkg-db-route', 'proxy'); });
    const direct = await page.evaluate(async () => (await (await sbFetch(SUPABASE_URL + '/rest/v1/x')).json()).direct);
    expect(direct, 'с VPN запрос не дошёл напрямую');
    expect(await page.evaluate(() => localStorage.getItem('skkg-db-route') === null), 'отметка обхода не снялась');
});

test('Через skkg.ru изменения других людей подтягиваются сами раз в минуту', async () => {
    const page = await openApp();
    const calls = await page.evaluate(async () => {
        sbRoute.proxy = true;
        const realInterval = window.setInterval; let tick = null;
        window.setInterval = (fn, ms) => { if (ms === 60000) tick = fn; return 0; };
        let n = 0; window.refreshAllData = async () => { n++; };
        let channels = 0; const ch = sb.channel; sb.channel = (...a) => { channels++; return ch.apply(sb, a); };
        subscribeRealtime();
        window.setInterval = realInterval;
        if (tick) tick();
        return { n, channels, hasTick: !!tick };
    });
    expect(calls.hasTick && calls.n === 1, 'обновление раз в минуту не настроено');
    expect(calls.channels === 0, 'через skkg.ru не нужно подключать мгновенные обновления');
});

test('Нет связи с базой — кнопка «Войти» показывает понятную ошибку, а не молчит', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, r => r.fulfill({ status: 200, body: '' }));
    await page.route(/vendor\/supabase\.js/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE_SUPABASE }));
    await page.route(/service-worker\.js/, r => r.fulfill({ contentType: 'application/javascript', body: 'self.addEventListener("install", () => self.skipWaiting());' }));
    await page.goto(baseUrl + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof handleLogin === 'function');
    await page.evaluate(() => {
        sb.auth.signInWithPassword = () => new Promise((_, reject) => setTimeout(() => reject(new TypeError('Failed to fetch')), 300));
        ['authCheckingScreen', 'appRoot'].forEach(id => document.getElementById(id)?.classList.add('hidden'));
        document.getElementById('loginScreen').classList.remove('hidden');
    });
    await page.fill('#loginEmail', 'a@b.ru');
    await page.fill('#loginPassword', '123456');
    await page.click('#loginFormEl button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('#loginFormEl button[type="submit"]').disabled, null, { timeout: 2000 });
    await page.waitForFunction(() => !document.getElementById('authError').classList.contains('hidden'), null, { timeout: 5000 });
    const txt = await page.textContent('#authError');
    expect(/Нет связи с базой/.test(txt), 'текст ошибки: ' + txt);
    expect(await page.evaluate(() => !document.querySelector('#loginFormEl button[type="submit"]').disabled), 'кнопка «Войти» осталась заблокированной');
});

// Лист МАФ: две линии борта (y = 10 и y = 20 м), три МАФ с номерами, ведомость и список МАФ для отметок.
function mafSheetHtml(extra = []) {
    const box = ([x0, x1, y0, y1]) => `M${x0} ${y0}L${x1} ${y0} ${x1} ${y1} ${x0} ${y1}z`;
    const items = [{ id: 'А1', p: 'У-1', z: 'Двор', box: [5, 5.3, 11, 11.3] }, { id: 'А2', p: 'У-1', z: 'Бульвар', box: [10, 10.3, 11, 11.3] }, { id: 'А3', p: 'СК-1', z: 'Двор', box: [20, 22, 11, 11.6] }, ...extra];
    const plan = '<path class="st" data-s="ctx" stroke="#777" d="M0 10L40 10"/><path class="st" data-s="ctx" stroke="#777" d="M0 20L40 20"/>'
        + items.map(i => `<g class="it" data-s="maf" data-p="${i.p}" data-id="${i.id}"><path class="mf" fill="#f97316" d="${box(i.box)}"/></g>`).join('');
    const planz = require('zlib').gzipSync(Buffer.from(plan)).toString('base64');
    const quants = [{ pos: 'У-1', name: 'Урна тестовая У-1', unit: 'шт', qty: 2, category: 'МАФ', section: 'МАФ' }, { pos: 'СК-1', name: 'Скамья тестовая СК-1', unit: 'шт', qty: 1, category: 'МАФ', section: 'МАФ' }];
    return `<!doctype html><svg id="plan" viewBox="0 0 40 30"><g id="root"></g></svg>
<script id="skkg-quantities" type="application/json">${JSON.stringify(quants)}</script>
<script id="skkg-maf" type="application/json">${JSON.stringify({ items, names: { 'У-1': 'Урна', 'СК-1': 'Скамья' } })}</script>
<script>const PLANZ="${planz}";</script>`;
}
async function openStage(page, html, btn) {
    await page.evaluate(async ([h, maf]) => {
        __files['p1/test-sheet.html'] = h;
        currentUserProfile = { id: 'u1', full_name: 'Грег' };
        appData.drawings = __db.drawings.map(d => ({ ...d }));
        await openDrawingViewer('d1', { maf });
    }, [html, !btn]);
    // Без кнопки — открываем как из «Объёмов», сразу в режиме «МАФ»; дожидаемся, пока план и отметки загрузятся.
    await page.waitForFunction(maf => notesState?.html != null && (!maf || !notesState.mafData || (notesState.open && notesState.vb && notesState.maf.loaded)), !btn, { timeout: 15000 });
    if (btn) {
        await page.click(btn);
        await page.waitForFunction(() => notesState?.vb && notesState.open, null, { timeout: 15000 });
    }
}
async function stageTap(page, x, y) { const [sx, sy] = await notesToScreen(page, x, y); await page.mouse.click(sx, sy); }

test('МАФ: отмечаю установленные на плане — видно факт и остаток, в «Объёмах» тоже', async () => {
    const page = await openApp({ admin: true });
    await openStage(page, mafSheetHtml());
    expect(await page.$eval('#mafBtn', b => !b.classList.contains('hidden') && b.innerText.includes('К чертежу')), 'лист с МАФ не открылся сразу в режиме «МАФ»');
    await page.waitForFunction(() => notesState?.maf.loaded && document.querySelectorAll('#notesMarks [data-maf]').length === 3, null, { timeout: 15000 });
    expect((await page.textContent('#mafTotals')).replace(/\s+/g, ' ').includes('Установлено 0 из 3 · осталось 3'), 'неверный итог до отметок: ' + await page.textContent('#mafTotals'));
    // Урна А1 маленькая (30 см) — попадаем по кружку вокруг неё.
    await stageTap(page, 5.15, 11.15);
    await page.waitForFunction(() => __db.maf_installs.length === 1);
    const row = await page.evaluate(() => __db.maf_installs[0]);
    expect(row.item_id === 'А1' && row.mark === 'У-1' && row.project_id === 'p1' && row.sheet === 'лист 1 тестовый посадочный план' && row.installed_by_name === 'Грег', 'отметка сохранена неверно: ' + JSON.stringify(row));
    expect((await page.textContent('#mafTotals')).replace(/\s+/g, ' ').includes('Установлено 1 из 3 · осталось 2'), 'итог не обновился: ' + await page.textContent('#mafTotals'));
    const u1 = await page.$$eval('[data-maf-mark="У-1"] td', tds => tds.slice(1).map(td => td.textContent.trim()).join('/'));
    expect(u1 === '2/1/1', 'по У-1 ожидалось проект 2 / уст. 1 / ост. 1, получено ' + u1);
    expect(await page.$eval('#notesMarks [data-maf="А1"]', g => g.dataset.done) === '1', 'установленная урна не стала зелёной');
    // Повторное касание снимает отметку (после подтверждения).
    page.once('dialog', d => d.accept());
    await stageTap(page, 5.15, 11.15);
    await page.waitForFunction(() => __db.maf_installs.length === 0);
    // Отмечаем скамью и урну — в «Объёмах» у материалов видно «Установлено».
    await stageTap(page, 21, 11.3);
    await stageTap(page, 10.15, 11.15);
    await page.waitForFunction(() => __db.maf_installs.length === 2);
    // Участок: только МАФ двора — итог и таблица по нему, план приближается к участку.
    await page.selectOption('#mafZone', 'Двор');
    expect((await page.textContent('#mafTotals')).replace(/\s+/g, ' ').includes('Установлено 1 из 2 · осталось 1'), 'итог по участку «Двор»: ' + await page.textContent('#mafTotals'));
    expect(await page.$$eval('[data-maf-mark]', r => r.map(x => x.dataset.mafMark).join()) === 'СК-1,У-1', 'марки участка не по порядку');
    await page.selectOption('#mafZone', '');
    // По марке — список номеров, каждый можно показать на плане.
    await page.click('[data-maf-mark="У-1"]');
    expect((await page.textContent('#notesList')).includes('А2'), 'нет списка урн по номерам');
    await page.click('#mafBtn');
    await page.evaluate(() => closeDrawingViewer());
    await page.evaluate(() => showVolumesScreen());
    await importFromDrawings(page);
    await page.waitForFunction(() => document.querySelectorAll('#volumesList [data-installed]').length === 2, null, { timeout: 15000 });
    const cards = await page.$$eval('#volumesList button', bs => bs.map(b => b.innerText.replace(/\s+/g, ' ')));
    const urn = cards.find(c => c.includes('Урна тестовая')), bench = cards.find(c => c.includes('Скамья тестовая'));
    expect(urn && urn.includes('Установлено 1 из 2 · осталось установить 1'), 'в «Объёмах» у урны нет факта установки: ' + urn);
    expect(bench && bench.includes('Установлено 1 из 1 · осталось установить 0'), 'в «Объёмах» у скамьи нет факта установки: ' + bench);
    expect(await page.$('#volumesList details[data-sec="МАФ"]'), 'в «Объёмах» нет папки «МАФ»');
    // Отметки МАФ — в «По зонам»: у листа с МАФ кнопка «Отметить установку МАФ» (даже если «Чертежи» не открывали).
    await page.evaluate(async () => { appData.drawings = []; await showVolumesScreen(); });
    await page.waitForSelector('#volumesList details[data-sec="МАФ"]', { timeout: 15000 });
    await page.evaluate(() => openZonesCounter());
    // Лист с МАФ сразу открывает план монтажа — без лишних кнопок.
    await page.waitForSelector('#zonesMafBtn', { timeout: 15000 });
    expect((await page.textContent('#zonesMafBox')).replace(/\s+/g, ' ').includes('Установлено 2 из 3'), 'в «По зонам» нет итога МАФ: ' + await page.textContent('#zonesMafBox'));
    expect(!(await page.$('#zonesMafTopBtn')), 'осталась оранжевая кнопка «Монтаж МАФ»');
    await page.waitForFunction(() => notesState?.open && notesState.mode === 'maf' && notesState.maf.loaded && document.querySelectorAll('#notesMarks [data-maf][data-done="1"]').length === 2, null, { timeout: 15000 });
    expect(await page.$eval('#drawingViewerModal', el => el.style.zIndex === '70'), 'план МАФ открылся под «По зонам»');
    // Отметили ещё один и закрыли — «По зонам» на месте, итог обновился.
    await stageTap(page, 5.15, 11.15);
    await page.waitForFunction(() => __db.maf_installs.length === 3);
    await page.evaluate(() => closeDrawingViewer());
    await page.waitForFunction(() => (document.getElementById('zonesMafBox')?.textContent || '').replace(/\s+/g, ' ').includes('Установлено 3 из 3'), null, { timeout: 15000 });
    await page.evaluate(() => closeZones());
    // А из «Чертежей» тот же лист — обычный просмотр, без кнопки «МАФ».
    await page.evaluate(() => closeDrawingViewer());
    await page.evaluate(() => openDrawingViewer('d1'));
    await page.waitForFunction(() => notesState?.mafData);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => !notesState.open && document.getElementById('mafBtn').classList.contains('hidden')), 'из «Чертежей» лист открылся в режиме МАФ');
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('МАФ: отмечаю подряд несколько, реестр отмеченных, подсветка остатка, выгрузка в Excel', async () => {
    const page = await openApp({ admin: true });
    await openStage(page, mafSheetHtml());
    await page.waitForFunction(() => document.querySelectorAll('#notesMarks [data-maf]').length === 3, null, { timeout: 15000 });
    // Несколько касаний подряд — каждое отмечает свой МАФ, ничего не снимается.
    await stageTap(page, 21, 11.3);
    await stageTap(page, 5.15, 11.15);
    await page.waitForFunction(() => __db.maf_installs.length === 2);
    expect(await page.$$eval('#notesMarks [data-maf][data-done="1"]', g => g.map(x => x.dataset.maf).sort().join()) === 'А1,А3', 'отмечены не оба МАФ');
    // Реестр: оба отмеченных, с датой и кто отметил.
    await page.click('[data-maf-tab="reg"]');
    const reg = await page.$$eval('#mafRegistry [data-maf-row]', r => r.map(x => x.dataset.mafRow + ':' + x.innerText.replace(/\s+/g, ' ')));
    expect(reg.length === 2 && reg.every(r => r.includes('Грег')) && reg.some(r => r.startsWith('А3:') && r.includes('СК-1')), 'реестр неверный: ' + reg.join(' | '));
    // Остаток: на плане установленные притушены, оставшийся мигает; во вкладке — только он.
    await page.click('[data-maf-show="left"]');
    expect(await page.$eval('#notesMarks [data-maf="А2"]', g => !!g.querySelector('.maf-pulse') && !g.getAttribute('opacity')), 'оставшийся МАФ не подсвечен');
    expect(await page.$eval('#notesMarks [data-maf="А1"]', g => g.getAttribute('opacity') === '0.12' && !g.querySelector('.maf-pulse')), 'установленный не притушен');
    expect(await page.$$eval('#mafRegistry [data-maf-row]', r => r.map(x => x.dataset.mafRow).join()) === 'А2', 'во вкладке «Остаток» не только А2');
    // Реестр в Excel (CSV): все три МАФ со статусом.
    await page.evaluate(() => { const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { window.__dlName = this.download; return c.call(this); }; });
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Скачать реестр (Excel)')]);
    const csv = require('fs').readFileSync(await dl.path(), 'utf8');
    const dlName = await page.evaluate(() => window.__dlName);
    expect(/^Реестр МАФ - Лист 1.*\.csv$/.test(dlName) && csv.split('\r\n').length === 4 && /"А3";"СК-1";"Скамья";"Двор";"установлен";"[\d.]+";"Грег"/.test(csv) && csv.includes('"А2";"У-1";"Урна";"Бульвар";"не установлен"'), 'CSV неверный: ' + dlName + ' ' + JSON.stringify(csv));
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('МАФ: плотно стоящие — выбор из списка, касание внутри рамки — сразу нужный', async () => {
    const page = await openApp({ admin: true });
    // Три велопарковки вплотную (0,74 м шириной, шаг 0,9 м).
    const racks = [0, 1, 2].map(i => ({ id: 'В' + (i + 1), p: 'У-1', z: 'Двор', box: [30 + i * 0.9, 30.74 + i * 0.9, 24, 25.85] }));
    await openStage(page, mafSheetHtml(racks));
    await page.waitForFunction(() => document.querySelectorAll('#notesMarks [data-maf]').length === 6, null, { timeout: 15000 });
    // Весь лист: парковки сливаются — касание между ними открывает список, ничего не отмечая.
    await stageTap(page, 30.82, 24.9);
    await page.waitForSelector('#mafPick:not(.hidden)');
    const ids = await page.$$eval('#mafPick [data-maf-pick]', b => b.map(x => x.dataset.mafPick).sort().join());
    expect(/^В1,В2(,В3)?$/.test(ids), 'в списке не те МАФ: ' + ids);
    expect(await page.evaluate(() => __db.maf_installs.length) === 0, 'отметилось без выбора');
    await page.click('#mafPick [data-maf-pick="В2"]');
    await page.waitForFunction(() => __db.maf_installs.length === 1);
    expect(await page.evaluate(() => __db.maf_installs[0].item_id) === 'В2' && await page.$eval('#mafPick', el => el.classList.contains('hidden')), 'выбор из списка не отметил В2');
    // Приблизили — касание внутри рамки В3 отмечает именно её, без списка.
    await page.evaluate(() => { notesState.vb = [28, 22, 6, 6]; notesApplyViewBox(); });
    await stageTap(page, 32.17, 24.5);
    await page.waitForFunction(() => __db.maf_installs.length === 2);
    expect(await page.evaluate(() => __db.maf_installs[1].item_id) === 'В3', 'касание внутри рамки отметило не В3');
    // Рамка стоит ровно на проектных координатах объекта.
    const r = await page.$eval('#notesMarks [data-maf="В3"] rect', el => [el.getAttribute('x'), el.getAttribute('y'), el.getAttribute('width')].map(Number));
    expect(near(r[0], 31.8, 1e-6) && near(r[1], 24, 1e-6) && near(r[2], 0.74, 1e-6), 'рамка сдвинута: ' + r);
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('МАФ: без прав ответственного отметку поставить нельзя; без таблицы — подсказка', async () => {
    const page = await openApp({ admin: false });
    await page.evaluate(() => { __missingTables.push('maf_installs'); });
    await openStage(page, mafSheetHtml());
    await page.waitForFunction(() => notesState?.maf.loaded);
    expect((await page.textContent('#notesList')).includes('maf_installs.sql'), 'нет подсказки про таблицу maf_installs');
    let msg = '';
    page.once('dialog', d => { msg = d.message(); d.dismiss(); });
    await stageTap(page, 21, 11.3);
    await page.waitForFunction(() => true);
    expect(/ответственный за чертежи/.test(msg), 'нет предупреждения о правах: ' + msg);
    expect(!(await page.evaluate(() => (__db.maf_installs || []).length)), 'отметка сохранилась без прав');
});

test('Замер: линейка показывает длину и прилипает к линиям чертежа', async () => {
    const page = await openApp();
    const marksText = async () => (await page.textContent('#notesMarks')).replace(/[\u00a0\u202f]/g, ' ');
    await openStage(page, mafSheetHtml(), '#measureBtn');
    // Протянули от линии y=10 до линии y=20, чуть мимо — концы прилипают к линиям: ровно 10 м.
    const [ax, ay] = await notesToScreen(page, 30.03, 10.15), [bx, by] = await notesToScreen(page, 30, 19.88);
    await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move((ax + bx) / 2, (ay + by) / 2); await page.mouse.move(bx, by); await page.mouse.up();
    let m = await page.evaluate(() => notesState.measures.map(x => [x.a, x.b]));
    expect(m.length === 1 && near(m[0][0][1], 10, 1e-6) && near(m[0][1][1], 20, 1e-6), 'концы не прилипли к линиям: ' + JSON.stringify(m));
    expect((await page.textContent('#notesMarks')).includes('10,00 м'), 'нет подписи «10,00 м»: ' + await page.textContent('#notesMarks'));
    // Касания мимо линейки новую линию не рисуют — план просто двигается.
    await stageTap(page, 35, 10.05);
    await stageTap(page, 35, 14.9);
    expect(await page.evaluate(() => notesState.measures.length) === 1, 'касание без «Новый замер» нарисовало линию');
    // Тянем нижний конец (кружок) вправо — линейка поворачивается и меняет длину; конец прилипает к линии y=20.
    const drag = async (from, to) => { const [fx, fy] = await notesToScreen(page, ...from), [tx, ty] = await notesToScreen(page, ...to); await page.mouse.move(fx, fy); await page.mouse.down(); await page.mouse.move((fx + tx) / 2, (fy + ty) / 2); await page.mouse.move(tx, ty); await page.mouse.up(); };
    await drag([30, 20], [37.5, 19.9]);
    m = await page.evaluate(() => notesState.measures);
    expect(m.length === 1 && near(m[0].b[0], 37.5, 0.2) && near(m[0].b[1], 20, 1e-6) && near(m[0].a[1], 10, 1e-6), 'конец линейки не перетащился: ' + JSON.stringify(m));
    expect(/12,4\d м/.test(await marksText()), 'длина после поворота не ~12,5 м: ' + JSON.stringify(await marksText()));
    // Тянем за середину — линейка переносится целиком, длина та же.
    await drag([33.75, 15], [28.75, 15]);
    m = await page.evaluate(() => notesState.measures);
    expect(m.length === 1 && near(m[0].a[0], 25, 0.2) && near(m[0].b[0], 32.5, 0.3) && /12,4\d м/.test(await marksText()), 'линейка не перенеслась: ' + JSON.stringify(m));
    // «Новый замер» — две точки касанием: от линии до точки в 4,9 м от неё — в миллиметрах.
    await page.click('#rulerNewBtn');
    await stageTap(page, 35, 10.05);
    await stageTap(page, 35, 14.9);
    m = await page.evaluate(() => notesState.measures.length);
    expect(m === 2 && (await marksText()).includes('4 900 мм'), 'замер двумя касаниями: ' + await marksText());
    // Замеры не сохраняются в базу и стираются кнопкой.
    expect(!(await page.evaluate(() => (__db.drawing_notes || []).length)), 'замер попал в замечания');
    // Выбранную линейку можно удалить по одной.
    await stageTap(page, 35, 12.5);
    await page.click('#rulerDelBtn');
    expect(await page.evaluate(() => notesState.measures.length) === 1, 'выбранный замер не удалился');
    await page.click('#rulerClearBtn');
    expect(await page.evaluate(() => notesState.measures.length) === 0, 'замеры не стёрлись');
    // На листе-картинке масштаба нет: первый замер спрашивает длину, дальше линейка считает по ней.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await page.click('#measureBtn');
    await openStage(page, `<!doctype html><img id="img" src="data:image/png;base64,${png}">`, '#measureBtn');
    page.once('dialog', d => d.accept('5'));
    const [cx, cy] = await notesToScreen(page, 0.1, 0.5), [dx, dy] = await notesToScreen(page, 0.6, 0.5);
    await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(dx, dy, { steps: 3 }); await page.mouse.up();
    await page.waitForFunction(() => notesState.scale);
    expect((await marksText()).includes('5 000 мм'), 'масштаб листа-картинки не применился: ' + await marksText());
    expect(!page.errors.length, 'ошибки на странице: ' + page.errors.join('; '));
});

test('sb.php пересылает запросы в базу и не пускает в чужие адреса', async () => {
    const got = [];
    const upstream = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            got.push({ url: req.url, method: req.method, headers: req.headers, body });
            res.writeHead(201, { 'Content-Type': 'application/json', 'Content-Range': '0-0/1', 'Access-Control-Allow-Origin': '*' });
            res.end('{"ok":true}');
        });
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const { spawn } = require('child_process');
    // Как на хостинге: предупреждения PHP включены — в ответ они попадать не должны.
    const php = spawn('php', ['-d', 'display_errors=1', '-d', 'error_reporting=-1', '-S', `127.0.0.1:${port}`, '-t', ROOT], { env: Object.assign({}, process.env, { SB_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` }), stdio: 'ignore' });
    try {
        const base = `http://127.0.0.1:${port}/sb.php?u=`;
        let r;
        for (let i = 0; i < 50; i++) { r = await fetch(base + encodeURIComponent('/rest/v1/tasks?select=*&id=eq.5'), { method: 'PATCH', headers: { apikey: 'k1', 'X-Sb-Authorization': 'Bearer tok', 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: '{"a":1}' }).catch(() => null); if (r) break; await new Promise(x => setTimeout(x, 100)); }
        expect(r, 'php не запустился (нужен PHP с curl)');
        expect(r.status === 201 && (await r.text()) === '{"ok":true}', 'ответ базы не дошёл: ' + r.status);
        expect(r.headers.get('content-range') === '0-0/1' && !r.headers.get('access-control-allow-origin') && r.headers.get('x-sb-proxy') === '1', 'заголовки ответа переданы неверно');
        const g = got[0];
        expect(g && g.url === '/rest/v1/tasks?select=*&id=eq.5' && g.method === 'PATCH' && g.body === '{"a":1}', 'запрос в базу передан неверно: ' + JSON.stringify(g && { url: g.url, method: g.method, body: g.body }));
        expect(g.headers.apikey === 'k1' && g.headers.authorization === 'Bearer tok' && g.headers.prefer === 'return=representation' && g.headers['content-type'] === 'application/json', 'заголовки запроса потерялись: ' + JSON.stringify(g.headers));
        for (const bad of ['//evil.com/x', '/../etc/passwd', 'https://evil.com', '/admin/v1/x', '/rest/v1/../../x']) {
            const b = await fetch(base + encodeURIComponent(bad));
            expect(b.status === 400, `чужой адрес ${bad} не отклонён: ${b.status}`);
        }
        expect(got.length === 1, 'в базу ушли лишние запросы');
    } finally {
        php.kill();
        upstream.close();
    }
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
    for (const t of tests.filter(t => !process.env.ONLY || t.name.includes(process.env.ONLY))) {
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
