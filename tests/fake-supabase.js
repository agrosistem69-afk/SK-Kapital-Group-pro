// Подменная база для автотестов: вместо настоящего Supabase приложение работает с таблицами в памяти браузера.
// Настоящие данные и ключи в тестах не участвуют.
(function () {
    window.__db = { projects: [], drawings: [], materials: [], material_deliveries: [], material_aliases: [], material_design_log: [], plan_zones: [], schedule_settings: [], schedule_items: [], schedule_progress: [] };
    window.__files = {};
    window.__rpc = { can_manage_drawings: false };
    const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(16).slice(2));
    const keysOf = { material_aliases: ['project_id', 'alias'], plan_zones: ['project_id', 'sheet'], schedule_settings: ['project_id'] };

    function query(table) {
        const st = { filters: [], op: 'select', payload: null, opts: {} };
        const match = r => st.filters.every(([c, v, op]) => op === 'in' ? v.includes(r[c]) : op === 'neq' ? r[c] !== v : r[c] === v);
        const run = () => {
            const db = window.__db;
            db[table] = db[table] || [];
            const rows = db[table];
            const list = p => (Array.isArray(p) ? p : [p]);
            if (st.op === 'insert') {
                const added = list(st.payload).map(r => ({ id: uuid(), created_at: new Date().toISOString(), ...r }));
                rows.push(...added);
                if (table === 'materials') added.forEach(r => db.material_design_log.push({ id: uuid(), material_id: r.id, project_id: r.project_id, material_name: r.name, unit: r.unit, old_qty: null, new_qty: r.design_qty, revision_date: r.revision_date, changed_at: new Date().toISOString() }));
                return { data: added, error: null };
            }
            if (st.op === 'update') {
                rows.filter(match).forEach(r => {
                    if (table === 'materials' && 'design_qty' in st.payload && st.payload.design_qty !== r.design_qty)
                        db.material_design_log.push({ id: uuid(), material_id: r.id, project_id: r.project_id, material_name: r.name, unit: r.unit, old_qty: r.design_qty, new_qty: st.payload.design_qty, revision_date: st.payload.revision_date ?? r.revision_date, changed_at: new Date().toISOString() });
                    Object.assign(r, st.payload);
                });
                return { data: null, error: null };
            }
            if (st.op === 'delete') { db[table] = rows.filter(r => !match(r)); return { data: null, error: null }; }
            if (st.op === 'upsert') {
                const keys = keysOf[table] || ['id'];
                list(st.payload).forEach(p => {
                    const e = rows.find(r => keys.every(k => r[k] === p[k]));
                    if (e) Object.assign(e, p); else rows.push({ id: uuid(), ...p });
                });
                return { data: null, error: null };
            }
            let data = rows.filter(match).map(r => ({ ...r }));
            if (st.single) return { data: data[0] || null, error: null };
            return { data, error: null };
        };
        const q = {
            select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; },
            eq(c, v) { st.filters.push([c, v]); return q; },
            neq(c, v) { st.filters.push([c, v, 'neq']); return q; },
            in(c, v) { st.filters.push([c, v, 'in']); return q; },
            insert(p) { st.op = 'insert'; st.payload = p; return q; },
            update(p) { st.op = 'update'; st.payload = p; return q; },
            upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o || {}; return q; },
            delete() { st.op = 'delete'; return q; },
            single() { st.single = true; return q; }, maybeSingle() { st.single = true; return q; },
            then(res, rej) { try { res(run()); } catch (e) { rej(e); } },
        };
        return q;
    }

    window.supabase = {
        createClient() {
            return {
                from: query,
                rpc: async name => ({ data: window.__rpc[name] ?? null, error: null }),
                storage: {
                    from: () => ({
                        download: async p => (p in window.__files ? { data: new Blob([window.__files[p]]), error: null } : { data: null, error: { message: 'нет файла ' + p } }),
                        upload: async () => ({ data: {}, error: null }),
                        remove: async () => ({ data: {}, error: null }),
                        createSignedUrl: async () => ({ data: null, error: null }),
                    }),
                },
                channel() { return { on() { return this; }, subscribe() { return this; } }; },
                removeChannel() {},
                auth: {
                    getSession: async () => ({ data: { session: null }, error: null }),
                    getUser: async () => ({ data: { user: null }, error: null }),
                    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
                    signOut: async () => ({ error: null }),
                },
            };
        },
    };
})();
