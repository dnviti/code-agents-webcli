const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The dashboard could only ever ask about the period the clock is standing in.
// `/api/usage/dashboard` has taken an `anchor` since accounting shipped and
// only these tests ever sent one, so `year` meant the viewer's calendar year:
// on 2027-01-01 every 2026 job would leave the dashboard, the trend, the
// history list and the export while sitting untouched in `usage_jobs`. (#56)
//
// The window arithmetic is here rather than in the browser checks because it
// is arithmetic — month lengths, year boundaries and the Monday-first week the
// server also uses — and a browser adds nothing to it. What the arrows do to
// the page is asserted in test/browser/checks.ts, where the page is.

const ROOT = path.join(__dirname, '..');

describe('Usage dashboard window', function () {
  let mod;
  let bundle;
  let realFetch;

  before(function () {
    this.timeout(60000);
    const contents = [
      `export { renderToStaticMarkup } from 'react-dom/server';`,
      `export * as React from 'react';`,
      `export { fetchUsageDashboard, usageExportUrl } from ${JSON.stringify(path.join(ROOT, 'src/client/chat/usage-api'))};`,
      `export { UsageDashboardDialog, periodStart, stepAnchor } from ${JSON.stringify(path.join(ROOT, 'src/client/shell/dialogs/UsageDashboardDialog'))};`,
    ].join('\n');

    bundle = path.join(os.tmpdir(), `usage-dashboard-window-${process.pid}.js`);
    require('esbuild').buildSync({
      stdin: { contents, resolveDir: ROOT, loader: 'tsx', sourcefile: 'usage-dashboard-window.tsx' },
      bundle: true,
      outfile: bundle,
      format: 'cjs',
      platform: 'node',
      jsx: 'automatic',
      target: ['node20'],
      logLevel: 'silent',
    });
    mod = require(bundle);
  });

  after(function () {
    if (bundle) fs.rmSync(bundle, { force: true });
  });

  beforeEach(function () {
    // Saved and put back rather than deleted: `fetch` is a real Node global and
    // removing it takes the rest of the run's HTTP tests down with it.
    realFetch = global.fetch;
  });

  afterEach(function () {
    global.fetch = realFetch;
  });

  /** The narrowest answer `fetchUsageDashboard` will accept, and the URLs asked for it. */
  function record() {
    const asked = [];
    global.fetch = async (url) => {
      asked.push(String(url));
      return {
        ok: true,
        json: async () => ({
          scope: 'self',
          canSeeEveryone: false,
          period: 'month',
          from: '2026-03-01T00:00:00.000Z',
          to: '2026-04-01T00:00:00.000Z',
          bucket: 'day',
          filters: {},
          totals: {},
          series: [],
          byAgent: [],
          byModel: [],
          byProject: [],
          effortByAgent: [],
          effortByModel: [],
          topTools: [],
          topToolsByAgent: [],
        }),
      };
    };
    return asked;
  }

  const paramOf = (url, name) => new URL(url, 'http://usage.test').searchParams.get(name);

  it('asks for the window the viewer moved to, not only for the one now is in', async function () {
    const asked = record();
    await mod.fetchUsageDashboard('month', 'self', {}, new Date('2026-03-15T12:00:00.000Z'));

    assert.strictEqual(asked.length, 1);
    assert.strictEqual(
      paramOf(asked[0], 'anchor'),
      '2026-03-15T12:00:00.000Z',
      `the anchor never reached the server: ${asked[0]}`,
    );
    assert.strictEqual(paramOf(asked[0], 'period'), 'month');
  });

  it('leaves the anchor off entirely while the viewer has not moved the window', async function () {
    const asked = record();
    await mod.fetchUsageDashboard('day', 'self', {});

    // Not "now" spelled out: pinned to the instant this page was loaded, a
    // dashboard left open overnight would go on reporting yesterday.
    assert.strictEqual(paramOf(asked[0], 'anchor'), null, asked[0]);
  });

  it('carries the narrowing and the anchor together', async function () {
    const asked = record();
    await mod.fetchUsageDashboard(
      'year',
      'everyone',
      { project: 'billing-api', from: '2026-03-02T00:00:00.000Z', to: '2026-03-03T00:00:00.000Z' },
      new Date('2026-07-15T12:00:00.000Z'),
    );

    assert.strictEqual(paramOf(asked[0], 'project'), 'billing-api');
    assert.strictEqual(paramOf(asked[0], 'from'), '2026-03-02T00:00:00.000Z');
    assert.strictEqual(paramOf(asked[0], 'anchor'), '2026-07-15T12:00:00.000Z');
  });

  it('steps back out of the new year into the old one, at every period', function () {
    // The exact morning #56 is about: the first day of a year in which the
    // whole of the previous year's record is suddenly unreachable.
    const newYear = new Date(2027, 0, 1, 9, 30);

    const day = mod.stepAnchor(newYear, 'day', -1);
    assert.strictEqual(day.getFullYear(), 2026);
    assert.strictEqual(day.getMonth(), 11);
    assert.strictEqual(day.getDate(), 31);

    const week = mod.stepAnchor(newYear, 'week', -1);
    assert.strictEqual(week.getFullYear(), 2026);
    assert.strictEqual(week.getMonth(), 11);
    assert.strictEqual(week.getDate(), 25);

    const month = mod.stepAnchor(newYear, 'month', -1);
    assert.strictEqual(month.getFullYear(), 2026);
    assert.strictEqual(month.getMonth(), 11);

    const year = mod.stepAnchor(newYear, 'year', -1);
    assert.strictEqual(year.getFullYear(), 2026);
  });

  it('never steps into a month that has no such day', function () {
    // 31 March back one month is not 31 February. Twelve steps from a 31st
    // must be twelve distinct months, not February arriving twice as March.
    let at = new Date(2026, 2, 31, 12);
    const months = [];
    for (let i = 0; i < 12; i += 1) {
      at = mod.stepAnchor(at, 'month', -1);
      months.push(`${at.getFullYear()}-${at.getMonth()}`);
    }

    assert.deepStrictEqual(months, [
      '2026-1', '2026-0', '2025-11', '2025-10', '2025-9', '2025-8',
      '2025-7', '2025-6', '2025-5', '2025-4', '2025-3', '2025-2',
    ]);
  });

  it('walks day by day without repeating or skipping one', function () {
    // Anchored at midday for this reason: the server bounds each window with
    // one fixed offset, so an anchor on a local midnight falls the wrong side
    // of the boundary across a daylight-saving change and the arrow lands back
    // on the day it started from.
    let at = new Date(2026, 9, 27, 12);
    const seen = new Set();
    for (let i = 0; i < 40; i += 1) {
      at = mod.stepAnchor(at, 'day', -1);
      seen.add(mod.periodStart(at, 'day').toDateString());
    }

    assert.strictEqual(seen.size, 40, 'a step landed on a day already walked over');
  });

  it('agrees with the server about which week a Sunday belongs to', function () {
    // Monday-first, the same rule `rangeFor` applies on the far side. A client
    // that started weeks on Sunday would light up "Next" a day early and name
    // a window the figures were never computed over.
    const sunday = new Date(2026, 0, 4, 12);
    const start = mod.periodStart(sunday, 'week');

    assert.strictEqual(start.getDay(), 1, `week starts on ${start.toDateString()}`);
    assert.strictEqual(start.getFullYear(), 2025);
    assert.strictEqual(start.getMonth(), 11);
    assert.strictEqual(start.getDate(), 29);
  });

  it('offers the controls that reach a period that has ended, and none that reach one that has not', function () {
    // The dialog before its first answer arrives: the window controls sit
    // beside the period tabs and do not wait on one, because what they move is
    // the question rather than the answer. Effects do not run in a static
    // render, so nothing here is fetched.
    const html = mod.renderToStaticMarkup(
      mod.React.createElement(mod.UsageDashboardDialog, { open: true, onClose() {} }),
    );

    // The whole tag, not the run before the label: attribute order is the
    // renderer's business, and a regex that only looked to the left of
    // `aria-label` reported a control as enabled purely because `disabled`
    // happened to be written after it.
    const control = (label) => {
      const match = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html);
      return match ? match[0] : null;
    };

    assert.ok(control('Previous day'), 'no control moves the window back');
    assert.ok(control('Next day'), 'no control moves the window forward');
    assert.match(
      control('Next day') || '',
      /disabled/,
      'the window opens on the period containing now, and offers to walk past it',
    );

    const field = /<input[^>]*type="date"[^>]*>/.exec(html);
    assert.ok(field, 'no date field to jump the window with');
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    assert.ok(
      field[0].includes(`max="${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`),
      `the date field offers a future nothing can have been recorded in: ${field[0]}`,
    );
  });

  it('puts a moved window into the export, because the export takes the range it is given', function () {
    // The dashboard hands `exportUsage` the `from`/`to` the server answered
    // with, so the file follows the arrows for free — as long as nothing in
    // between substitutes a range of its own.
    const url = mod.usageExportUrl('self', '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z', {
      project: 'billing-api',
      from: '2027-01-01T00:00:00.000Z',
      to: '2027-01-02T00:00:00.000Z',
    });

    assert.strictEqual(paramOf(url, 'from'), '2026-03-01T00:00:00.000Z');
    assert.strictEqual(paramOf(url, 'to'), '2026-04-01T00:00:00.000Z');
    assert.strictEqual(paramOf(url, 'project'), 'billing-api');
  });
});
