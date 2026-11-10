import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { emptyState, validateState } from '../src/financas/domain.ts';

const origin = process.env.FINANCAS_APP_BASE_URL || 'http://localhost:5173';
const supabaseOrigin = 'https://hcpvmahmiqipghceylle.supabase.co';
const output = fileURLToPath(new URL('../tmp/financas-app/', import.meta.url));
const routes = [
  ['', 'Visao geral'], ['caixa', 'Fluxo de caixa'], ['planejamento', 'Planejamento'],
  ['analise', 'Planejado x realizado'], ['projecao', 'Projecao de caixa'],
  ['categorias', 'Categorias'], ['pagamentos', 'Pagamentos / CNAB'],
  ['fechamentos', 'Fechamentos'],
  ['auditoria', 'Conferencia da origem'], ['configuracoes', 'Configuracoes'],
];
const payload = emptyState();
payload.source.name = 'BASE SINTETICA - INTEGRACAO APP';
payload.catalog = { income: ['Vendas'], expense: ['Administrativa', 'Logistica'], children: { Vendas: ['Recebimentos'], Administrativa: ['Aluguel'], Logistica: ['Frete'] } };
const identities = [
  { classification: 'Receita', category: 'Vendas', subcategory: 'Recebimentos', detail: 'Receita sintetica' },
  { classification: 'Despesa', category: 'Administrativa', subcategory: 'Aluguel', detail: 'Aluguel sintetico' },
  { classification: 'Despesa', category: 'Logistica', subcategory: 'Frete', detail: 'Frete sintetico' },
];
payload.plans = identities.map((identity, index) => ({
  ...identity, id: `synthetic-plan-${index}`, pix: '', notes: '', dueDay: 5, sourceRow: null,
  amounts: { '2026-09': [450000, 90000, 70000][index], '2026-10': [500000, 100000, 80000][index], '2026-11': [550000, 100000, 85000][index] }, actualMonths: [],
}));
payload.transactions = Array.from({ length: 12 }, (_, index) => ({
  ...identities[index % 3], id: `synthetic-tx-${index}`, date: `2026-10-${String(index + 1).padStart(2, '0')}`,
  description: `MOVIMENTO SINTETICO ${index + 1}`, amount: [125000, -24000, -18000][index % 3],
  balance: null, sourceRow: null, source: 'synthetic-browser', order: index,
}));
payload.projection.opening = 50000;
payload.issues = [{ code: 'SYNTHETIC', sheet: 'Teste', cell: 'A1', message: 'Ocorrencia sintetica de integracao' }];
validateState(payload);

function matches(row, params) {
  return [...params].every(([field, value]) => {
    if (['select', 'order', 'offset', 'limit'].includes(field)) return true;
    if (field === 'or' && value === '(registration_type.is.null,registration_type.eq.drop_off)') return row.registration_type == null || row.registration_type === 'drop_off';
    if (value.startsWith('eq.')) return String(row[field]) === value.slice(3);
    if (value === 'is.null') return row[field] == null;
    throw new Error(`Unsupported registration filter: ${field}=${value}`);
  });
}

async function fixture(browser, { email, authEmail = email, role = 'admin', active = true, mobile = false, permissions = {}, allowed = false, logged = true }) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block',
  });
  const user = { id: randomUUID(), email: authEmail, aud: 'authenticated' };
  const jwt = ['synthetic', Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'local-only'].join('.');
  const state = { rows: [], reads: [], writes: [], rpcs: [], bootstrap: [], blocked: [], errors: [], continued: [], consoleErrors: [] };
  await context.addInitScript(({ origin, user, jwt, logged }) => {
    if (location.origin !== origin || !logged) return;
    localStorage.setItem('sb-hcpvmahmiqipghceylle-auth-token', JSON.stringify({
      access_token: jwt, refresh_token: 'synthetic-local-only', token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user,
    }));
  }, { origin, user, jwt, logged });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.origin === origin.replace('http:', 'ws:')) socket.connectToServer();
    else { state.blocked.push(`${url.origin}${url.pathname}`); socket.close(); }
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (data, status = 200, headers = {}) => route.fulfill({
      status, contentType: 'application/json', body: JSON.stringify(data),
      headers: { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'content-range', ...headers },
    });
    try {
      if (url.origin === supabaseOrigin) {
        if (request.method() === 'GET' && url.pathname === '/auth/v1/user') return json(user);
        assert.ok(url.pathname.startsWith('/rest/v1/'), `Unexpected Supabase path ${url.pathname}`);
        const table = url.pathname.slice('/rest/v1/'.length);
        const singular = request.headers().accept?.includes('application/vnd.pgrst.object+json');
        if (table.startsWith('rpc/')) {
          state.rpcs.push({ name: table, method: request.method() });
          throw new Error(`RPC forbidden in this read-only finance suite: ${table}`);
        }
        if (request.method() === 'GET' || request.method() === 'HEAD') {
          state.reads.push(table);
          if (table === 'user_profiles') return json({ id: user.id, email, full_name: 'Perfil sintetico', role, is_active: active });
          if (table === 'user_module_permissions') return json({ user_id: user.id, ...permissions });
          if (table.startsWith('financas_')) {
            assert.equal(allowed, true, `DENIED profile fetched ${table}`);
            if (table === 'financas_members') return json({ role: 'editor' });
            if (table === 'financas_books') return json({ revision: 0, payload, updated_at: '2026-11-08T12:00:00Z' });
            assert.equal(table, 'financas_history');
            return json([]);
          }
          assert.ok(['drops', 'drop_photos', 'drop_documents', 'app_notes', 'mais_envios_registrations', 'mais_envios_stage_history',
            'financial_views', 'financial_periods', 'financial_payment_history', 'financial_drop_items', 'loss_events'].includes(table), `Unexpected table ${table}`);
          const filtered = table === 'drops' ? state.rows.filter(row => matches(row, url.searchParams)) : [];
          const offset = Number(url.searchParams.get('offset') || 0);
          const limit = Number(url.searchParams.get('limit') || filtered.length);
          const rows = filtered.slice(offset, offset + limit);
          return json(singular ? rows[0] ?? null : rows, 200, { 'content-range': rows.length ? `${offset}-${offset + rows.length - 1}/${filtered.length}` : `*/${filtered.length}` });
        }
        state.writes.push({ table, method: request.method(), payload: request.postDataJSON() });
        assert.equal(table, 'drops', 'No finance business writes are permitted');
        assert.equal(allowed, true, 'Only the authorized cadastro scenario writes');
        assert.equal(active, true);
        assert.equal(request.method(), 'POST', 'This scenario creates one cadastro');
        const row = { is_active: true, registration_type: null, ...state.writes.at(-1).payload };
        assert.match(row.id, /^[0-9a-f-]{36}$/i);
        assert.ok(!state.rows.some(existing => existing.id === row.id));
        state.rows.push(row);
        return json(singular ? row : [row]);
      }
      if (url.origin === origin) {
        if (url.pathname === '/api/drop-registration') {
          assert.equal(logged && active && (role === 'admin' || (permissions.cadastros_create && permissions.cadastros_edit)), true);
          assert.equal(request.method(), 'GET');
          assert.equal(request.headers().authorization, `Bearer ${jwt}`);
          state.reads.push('drop_registration_intake');
          return json({ submissions: [], nextOffset: null });
        }
        if (url.pathname === '/api/bootstrap-admin') {
          state.bootstrap.push(request.method());
          assert.equal(authEmail, 'talitapreviatti@gmail.com', 'Bootstrap only for the authorized identity');
          assert.equal(email, authEmail);
          assert.equal(active, true);
          assert.equal(request.method(), 'POST');
          assert.equal(request.headers().authorization, `Bearer ${jwt}`);
          return json({ ok: true });
        }
        if (url.pathname === '/api/contract-templates') {
          assert.equal(request.method(), 'GET');
          return json({ serviceTemplatePath: '', terminationTemplatePath: '' });
        }
        assert.ok(!url.pathname.startsWith('/api/'), `Unmocked local API ${url.pathname}`);
        assert.ok(['GET', 'HEAD'].includes(request.method()), `Unexpected local method ${request.method()}`);
        state.continued.push(url.origin);
        return route.continue();
      }
      state.blocked.push(`${url.origin}${url.pathname}`);
      return route.abort('blockedbyclient');
    } catch (error) {
      state.errors.push(error.message);
      return json({ message: error.message }, 500);
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') state.consoleErrors.push(entry.text()); });
  return { context, page, state, mobile };
}

function clean(state) {
  assert.deepEqual(state.errors, [], 'Mock contracts and App runtime');
  assert.deepEqual(state.consoleErrors, [], 'Browser console errors');
  assert.deepEqual(state.blocked, [], 'Unexpected external requests');
  assert.equal(state.rpcs.length, 0, 'No RPC allowed');
  assert.ok(state.continued.length > 0, 'Actual Vite App was loaded');
  assert.ok(state.continued.every(value => value === origin), 'Production requests never continue');
  assert.ok(state.writes.every(write => write.table === 'drops'), 'Only synthetic cadastro writes');
}

async function sharedLayout(page, mobile) {
  assert.equal(await page.locator('meta[name="viewport"]').getAttribute('content'), 'width=980', 'Global viewport must remain unchanged');
  assert.ok(await page.evaluate(expected => Math.abs(document.documentElement.clientWidth - expected) <= 1, mobile ? 980 : 1440));
  assert.equal(await page.locator('.app > aside').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(16, 29, 32)', 'Sidebar #101d20 must not be overridden');
}

async function clearControls(scope) {
  const controls = scope.locator('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]), select, textarea');
  assert.ok(await controls.count() > 0);
  const failures = await controls.evaluateAll(elements => elements.flatMap(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden') return [];
    const effective = [0, 0, 0];
    let opacity = 0;
    for (let ancestor = element; ancestor && opacity < 1; ancestor = ancestor.parentElement) {
      const channels = getComputedStyle(ancestor).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
      const alpha = channels[3] ?? 1;
      for (let channel = 0; channel < 3; channel++) effective[channel] += (channels[channel] ?? 0) * alpha * (1 - opacity);
      opacity += alpha * (1 - opacity);
    }
    for (let channel = 0; channel < 3; channel++) effective[channel] += 255 * (1 - opacity);
    const label = element.getAttribute('aria-label') || element.labels?.[0]?.textContent?.trim().slice(0, 70) || element.name;
    return Math.min(...effective) < 190 ? [`${label}: effective rgb(${effective.map(Math.round).join(', ')})`] : [];
  }));
  assert.deepEqual(failures, [], 'Visible form controls must have clear backgrounds');
}

async function visibleCommandsAndLabels(scope) {
  const problems = await scope.evaluate(root => {
    const failures = [];
    for (const button of root.querySelectorAll('button')) {
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      if (!rect.width || !rect.height || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) failures.push(`Hidden button: ${button.getAttribute('aria-label') || button.textContent.trim()}`);
    }
    for (const element of root.querySelectorAll('label, .financas-subnav a, .section-title h2')) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (element.scrollWidth > element.clientWidth + 2) failures.push(`Label horizontal overflow: ${element.textContent.trim().slice(0, 70)}`);
    }
    return failures;
  });
  assert.deepEqual(problems, [], 'Commands must remain rendered; labels must not overflow horizontally');
}

function tealPixels(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = [];
  let width, height, channels;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.equal(data[12], 0);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      assert.ok(channels, 'Expected RGB/RGBA screenshot');
    }
    if (type === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  let previous = Buffer.alloc(stride), cursor = 0, count = 0;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const filter = raw[cursor++];
    assert.ok(filter <= 4);
    const row = Buffer.alloc(stride);
    for (let index = 0; index < stride; index++) {
      const left = index >= channels ? row[index - channels] : 0;
      const above = previous[index];
      const upperLeft = index >= channels ? previous[index - channels] : 0;
      const estimate = left + above - upperLeft;
      const distances = [Math.abs(estimate - left), Math.abs(estimate - above), Math.abs(estimate - upperLeft)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? above : upperLeft;
      const prediction = [0, left, above, Math.floor((left + above) / 2), paeth][filter];
      row[index] = (raw[cursor++] + prediction) & 255;
    }
    for (let index = 0; index < stride; index += channels) {
      if (row[index] < 35 && row[index + 1] >= 115 && row[index + 1] <= 165 && row[index + 2] >= 100 && row[index + 2] <= 155) count++;
    }
    previous = row;
  }
  return count;
}

const captures = [];
async function capture(page, name, locator) {
  const path = resolve(output, `${name}.png`);
  const image = await (locator ?? page).screenshot({ path, ...(locator ? {} : { fullPage: true }), animations: 'disabled' });
  assert.ok(image.length > 1000, 'Nonempty screenshot');
  captures.push(path);
  return image;
}

async function dashboard(page, name) {
  const bars = page.locator('.recharts-bar-rectangle path');
  await bars.first().waitFor();
  const geometry = await bars.evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }));
  assert.ok(geometry.some(rect => rect.width > 10 && rect.height >= 5), 'Dashboard chart has real series geometry');
  const chart = page.locator('.chart-section').first();
  await chart.scrollIntoViewIfNeeded();
  const colored = tealPixels(await capture(page, `dashboard-chart-${name}`, chart));
  assert.ok(colored > 100, `Dashboard screenshot needs rendered teal bars, got ${colored} pixels`);
  await page.evaluate(() => scrollTo(0, 0));
  await capture(page, `dashboard-${name}`);
  return { bars: geometry.length, tealPixels: colored };
}

async function authorized(browser, mobile) {
  const current = await fixture(browser, { email: 'fabioaf9@gmail.com', active: true, allowed: true, mobile });
  const { page, state } = current;
  const name = mobile ? 'mobile' : 'desktop';
  try {
    await page.goto(`${origin}/financas`, { waitUntil: 'domcontentloaded' });
    await page.locator('.financas-module .page-footer').waitFor();
    assert.equal(await page.locator('.app > aside').getByRole('button', { name: 'Financeiro', exact: true }).isVisible(), true);
    assert.equal(await page.locator('.app > aside').getByRole('button', { name: 'Finan\u00e7as', exact: true }).count(), 0);
    assert.equal(await page.locator('.app > .content > header h1').innerText(), 'Financeiro');
    await page.locator('.app > aside').getByRole('button', { name: 'Fechamento', exact: true }).click();
    await page.getByRole('group', { name: 'Fechamento iMile', exact: true }).getByRole('button', { name: 'Importar base', exact: true }).waitFor();
    await capture(page, `closing-menu-${name}`);
    const module = page.locator('section.financas-module');
    assert.equal(await module.locator('.financas-subnav a').count(), routes.length);
    const chartProof = await dashboard(page, name);
    for (const [path, title] of routes) {
      await module.getByRole('link', { name: title, exact: true }).click();
      await page.waitForURL(url => url.pathname === (path ? `/financas/${path}` : '/financas'));
      await module.getByRole('heading', { level: 1, name: title, exact: true }).waitFor();
      await sharedLayout(page, mobile);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false, `Unexpected global overflow ${name}/${path}`);
      await visibleCommandsAndLabels(module);
      if (await module.locator('select, input:not([type=checkbox]):not([type=file])').count()) await clearControls(module);
      assert.equal(state.writes.length, 0, 'All finance routes are browsed read-only');
      assert.equal(state.rpcs.length, 0);
    }
    await module.getByRole('link', { name: 'Fluxo de caixa', exact: true }).click();
    await module.getByRole('button', { name: 'Novo lancamento', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await clearControls(dialog);
    await visibleCommandsAndLabels(dialog);
    await capture(page, `finance-form-${name}`);
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(state.writes.length, 0, 'Opening/cancelling finance form never saves');

    await page.locator('.app > aside .nav-parent').filter({ hasText: /^Cadastros/ }).click();
    await page.locator('.app > aside .nav-submenu').first().getByRole('button', { name: 'Drop off', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/cadastros');
    await page.getByRole('heading', { name: 'Cadastros', exact: true }).first().waitFor();
    await page.locator('.cadastros-list-page .result-count').waitFor();
    await capture(page, `cadastros-${name}`);
    await page.locator('.cadastros-list-page').getByRole('button', { name: '+ Novo cadastro', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/cadastros/novo');
    const form = page.locator('.cadastro-form');
    await form.waitFor();
    await sharedLayout(page, mobile);
    await clearControls(form);
    await visibleCommandsAndLabels(form);
    await page.getByLabel('Nome do Drop', { exact: true }).fill(`DROP SINTETICO FINANCAS ${name.toUpperCase()}`);
    await capture(page, `cadastro-form-${name}`);
    await form.getByRole('button', { name: 'Salvar e permanecer', exact: true }).click();
    await form.locator('> p[role=status]').filter({ hasText: 'Cadastro salvo com sucesso.' }).waitFor();
    await page.waitForURL(url => url.pathname === '/cadastros/novo' && /^[0-9a-f-]{36}$/i.test(url.searchParams.get('edit') || ''));
    assert.equal(state.writes.length, 1);
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].name, `DROP SINTETICO FINANCAS ${name.toUpperCase()}`);
    assert.equal(state.rows[0].id, new URL(page.url()).searchParams.get('edit'));
    await page.locator('.app > aside').getByRole('button', { name: 'Financeiro', exact: true }).click();
    await page.locator('.financas-module .page-footer').waitFor();
    await sharedLayout(page, mobile);
    assert.equal(await page.getByRole('combobox', { name: 'Competencia' }).inputValue(), '2026-10');
    assert.equal(state.writes.length, 1);
    assert.deepEqual(state.bootstrap, []);
    clean(state);
    console.log(`PASS Fabio ${name}: ${routes.length} rotas somente leitura; grafico ${JSON.stringify(chartProof)}; cadastro POST=1; Financas writes/RPC=0; viewport=980; sidebar=#101d20.`);
  } finally { await current.context.close(); }
}

async function accessScenarios(browser) {
  const talita = await fixture(browser, { email: 'talitapreviatti@gmail.com', role: 'operator', permissions: {}, allowed: true });
  try {
    await talita.page.goto(`${origin}/financas`, { waitUntil: 'domcontentloaded' });
    await talita.page.locator('.financas-module .page-footer').waitFor();
    assert.equal(await talita.page.locator('.app > aside').getByRole('button', { name: 'Financeiro', exact: true }).isVisible(), true);
    assert.equal(await talita.page.locator('.financas-subnav a').count(), routes.length);
    assert.ok(talita.state.bootstrap.length > 0);
    assert.ok(talita.state.bootstrap.every(method => method === 'POST'));
    assert.ok(talita.state.reads.includes('financas_books'));
    assert.equal(talita.state.writes.length, 0);
    clean(talita.state);
    console.log(`PASS Talita ativa: App autenticado, ${routes.length} abas, acesso sem role admin/permissoes; bootstrap autorizado e interceptado.`);
  } finally { await talita.context.close(); }

  const allPermissions = Object.fromEntries(['cadastros_view', 'cadastros_create', 'cadastros_edit', 'cadastros_delete', 'financeiro_view', 'financeiro_manage', 'financas_view', 'financas_manage', 'financas_access', 'funcionarios_view', 'configuracoes_manage'].map(name => [name, true]));
  for (const scenario of [
    { name: 'Outro admin com todas permissoes', email: 'other-admin@example.test', permissions: allPermissions },
    { name: 'Outro perfil apesar de auth Fabio', email: 'other-admin@example.test', authEmail: 'fabioaf9@gmail.com', permissions: allPermissions },
    { name: 'Fabio inativo', email: 'fabioaf9@gmail.com', active: false, permissions: allPermissions },
  ]) {
    const current = await fixture(browser, { ...scenario, allowed: false });
    try {
      await current.page.goto(`${origin}/financas`, { waitUntil: 'domcontentloaded' });
      await current.page.getByRole('heading', { name: 'Acesso restrito', exact: true }).waitFor();
      assert.equal(await current.page.locator('.app > aside').getByRole('button', { name: 'Financeiro', exact: true }).count(), 0);
      assert.equal(await current.page.locator('.financas-module').count(), 0);
      assert.ok(!current.state.reads.some(table => table.startsWith('financas_')), 'Gate must prevent every private finance fetch');
      assert.equal(current.state.rpcs.length, 0);
      assert.equal(current.state.writes.length, 0);
      assert.deepEqual(current.state.bootstrap, []);
      await current.page.goto(`${origin}/financas/caixa`, { waitUntil: 'domcontentloaded' });
      await current.page.getByRole('heading', { name: 'Acesso restrito', exact: true }).waitFor();
      assert.ok(!current.state.reads.some(table => table.startsWith('financas_')));
      if (scenario.active !== false) {
        const legacyReads = ['financial_views', 'financial_periods', 'financial_drop_items', 'financial_payment_history', 'loss_events'].map(table =>
          current.page.waitForResponse(response => new URL(response.url()).pathname === `/rest/v1/${table}`));
        await current.page.locator('.app > aside').getByRole('button', { name: 'Fechamento', exact: true }).click();
        await current.page.locator('.app > aside').getByRole('button', { name: 'Importar base', exact: true }).click();
        await current.page.waitForURL(url => url.pathname === '/financeiro');
        await current.page.locator('.finance-page').waitFor();
        await Promise.all(legacyReads);
        await current.page.getByRole('heading', { name: 'Novo fechamento quinzenal', exact: true }).waitFor();
        assert.equal(await current.page.getByRole('heading', { name: 'Acesso restrito', exact: true }).count(), 0);
        assert.equal(await current.page.locator('.financas-module').count(), 0);
        assert.ok(!current.state.reads.some(table => table.startsWith('financas_')));
      }
      clean(current.state);
      console.log(`PASS ${scenario.name}: menu ausente, /financas e /financas/caixa restritos; private fetch/RPC=0${scenario.active !== false ? '; /financeiro antigo acessivel' : ''}.`);
    } finally { await current.context.close(); }
  }
}

async function registrationRoutes(browser) {
  const anonymous = await fixture(browser, { email: 'public@example.test', logged: false, mobile: true });
  try {
    await anonymous.page.goto(`${origin}/cadastrar-drop`, { waitUntil: 'domcontentloaded' });
    await anonymous.page.getByRole('heading', { name: 'Pre-cadastro Drop', exact: true }).waitFor();
    assert.equal(await anonymous.page.locator('.app, .auth-panel').count(), 0);
    assert.equal(await anonymous.page.locator('meta[name=viewport]').getAttribute('content'), 'width=device-width, initial-scale=1');
    await anonymous.page.locator('.dr-header img').evaluate(image => image.decode());
    assert.deepEqual(anonymous.state.reads, []);
    await capture(anonymous.page, 'public-registration-mobile');
    clean(anonymous.state);
  } finally { await anonymous.context.close(); }
  for (const mobile of [false, true]) {
    const reviewer = await fixture(browser, { email: 'fabioaf9@gmail.com', allowed: true, mobile });
    try {
      await reviewer.page.goto(`${origin}/cadastros/pre-cadastros`, { waitUntil: 'domcontentloaded' });
      await reviewer.page.getByRole('heading', { name: 'Pre-cadastros de Drop', exact: true }).waitFor();
      await reviewer.page.getByText('Nenhum pre-cadastro neste status.', { exact: true }).waitFor();
      assert.equal(await reviewer.page.getByRole('button', { name: 'Copiar link de pre-cadastro' }).isVisible(), true);
      assert.ok((await reviewer.page.locator('.app > .content > header').boundingBox()).y < 120, 'Review starts at top of panel');
      assert.ok(reviewer.state.reads.includes('drop_registration_intake'));
      assert.equal(reviewer.state.writes.length, 0);
      assert.equal(await reviewer.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false);
      await capture(reviewer.page, `registration-review-${mobile ? 'mobile' : 'desktop'}`);
      clean(reviewer.state);
    } finally { await reviewer.context.close(); }
  }
  console.log('PASS rotas reais: cadastro publico sem login/leitura privada e revisao autenticada desktop/mobile, sem escritas.');
}

const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(5000) }).catch(error => {
  throw new Error(`Vite localhost:5173 indisponivel; nenhum servidor foi iniciado. ${error.message}`);
});
assert.equal(response.status, 200);
const html = await response.text();
assert.ok(html.includes('/@vite/client') && html.includes('/src/main.tsx'), 'Requires existing actual Vite development server');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  await registrationRoutes(browser);
  await accessScenarios(browser);
  await authorized(browser, false);
  await authorized(browser, true);
  console.log(`PASS FINANCAS APP: 6 contextos autenticados; ${routes.length * 2} navegacoes Financas; 2 cadastros sinteticos; zero producao, zero gravacoes financeiras, zero RPC.`);
  console.log(`Screenshots sinteticos:\n${captures.map(path => path.replaceAll('\\', '/')).join('\n')}`);
} finally { await browser.close(); }