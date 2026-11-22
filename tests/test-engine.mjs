/** Actual scientific engine regression tests, executed in webR (real R/Wasm).
 * Runtime: `npm install webr@0.6.0` or set WEBR_MODULE to webr/dist/webr.cjs.
 * The task-local runtime is used automatically when present.
 * These tests check computational behavior, not biological validity.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let runtimeModule = process.env.WEBR_MODULE;
if (!runtimeModule) {
  const local = new URL('../../../work/runtime/node_modules/webr/dist/webr.cjs', import.meta.url);
  try { await access(local); runtimeModule = fileURLToPath(local); } catch { runtimeModule = 'webr'; }
}
const { WebR } = require(runtimeModule);
const webR = new WebR({ interactive: false });
const checks = [];
const fixtures = [];
let started = Date.now();
const check = (name, fn) => { fn(); checks.push({ name, passed: true }); };
const relative = (actual, expected) => Math.abs(actual - expected) / Math.max(Math.abs(expected), Number.MIN_VALUE);
const parseCsv = text => text.trim().split(/\r?\n/).slice(1).map(line => {
  const [S, I, v] = line.split(',').map(Number); return { S, I, v };
});
const makeCsv = rows => 'S,I,v\n' + rows.map(row => `${row.S},${row.I},${row.v}`).join('\n') + '\n';
const fixtureDir = new URL('../data/', import.meta.url);

try {
  await webR.init();
  const rVersion = await webR.evalRString('R.version.string');
  console.log(`Runtime: webR ${webR.version}; ${rVersion}`);
  const source = await readFile(new URL('../dist/engine.R', import.meta.url), 'utf8');
  await webR.evalRVoid(source);
  const analyze = async (csv, bounds = [2, 200, 80]) => {
    const code = `ed_analyze(${JSON.stringify(csv)}, ${bounds.join(', ')})`;
    return JSON.parse(await webR.evalRString(code));
  };
  const truth = JSON.parse(await readFile(new URL('ground-truth.json', fixtureDir), 'utf8'));
  for (const fixture of truth.fixtures.filter(x => !x.file.startsWith('weak-'))) {
    const t = Date.now();
    const csv = await readFile(new URL(fixture.file, fixtureDir), 'utf8');
    const result = await analyze(csv);
    const best = result.models[0];
    const actualModel = result.models.find(x => x.id === fixture.model);
    check(`${fixture.file}: correct preferred candidate`, () => assert.equal(best.id, fixture.model));
    check(`${fixture.file}: four models / all input rows retained`, () => {
      assert.equal(result.models.length, 4); assert.equal(result.n, fixture.n);
      assert.equal(result.data.length, fixture.n);
    });
    check(`${fixture.file}: weights sum to one`, () =>
      assert.ok(Math.abs(result.models.reduce((s, m) => s + m.weight, 0) - 1) < 1e-10));
    check(`${fixture.file}: variance included in AICc parameter count`, () =>
      result.models.forEach(model => assert.equal(model.k, model.p + 1)));
    check(`${fixture.file}: kinetic parameter recovery`, () => {
      const tolerance = fixture.noise_sd === 0 ? 0.005 : 0.30;
      for (const [key, expected] of Object.entries(fixture.parameters)) {
        assert.ok(relative(actualModel.params[key], expected) < tolerance,
          `${key}: obtained ${actualModel.params[key]}, expected ${expected}, tolerance ${tolerance}`);
      }
    });
    check(`${fixture.file}: finite residuals, predictions and approximate CIs`, () => {
      for (const model of result.models) {
        assert.equal(model.predictions.length, fixture.n);
        assert.equal(model.residuals.length, fixture.n);
        assert.ok(model.predictions.every(Number.isFinite));
        assert.ok(model.residuals.every(Number.isFinite));
        for (const [key, interval] of Object.entries(model.ci)) {
          assert.equal(interval.length, 2);
          if (interval[0] !== null) {
            assert.ok(interval[0] > 0 && interval[1] >= interval[0]);
            assert.ok(interval[0] <= model.params[key] && interval[1] >= model.params[key]);
          }
        }
      }
    });
    check(`${fixture.file}: fixed grouped holdout retains replicate groups`, () => {
      assert.equal(result.holdout.available, true);
      assert.equal(result.holdout.trainN + result.holdout.testN, fixture.n);
      assert.equal(result.holdout.testN % fixture.replicates_per_condition, 0);
      assert.ok(Number.isFinite(actualModel.cvRmse));
    });
    fixtures.push({ file: fixture.file, trueModel: fixture.model, preferredModel: best.id,
      trueModelParameters: actualModel.params, rmse: actualModel.rmse,
      holdoutRmse: actualModel.cvRmse, status: result.diagnostics.status,
      seconds: (Date.now() - t) / 1000 });
    console.log(`PASS ${fixture.file}: ${best.id}; RMSE ${actualModel.rmse.toPrecision(4)}; ${(Date.now() - t) / 1000}s`);
  }

  const baselineCsv = await readFile(new URL('competitive-noisy.csv', fixtureDir), 'utf8');
  const baselineRows = parseCsv(baselineCsv);
  const baseline = await analyze(baselineCsv, [4, 120, 30]);
  check('Experiment proposals respect bounds and exclude measured pairs', () => {
    assert.equal(baseline.design.length, 8);
    for (const proposal of baseline.design) {
      assert.ok(proposal.S >= 4 * (1 - 1e-12) && proposal.S <= 120 * (1 + 1e-12));
      assert.ok(proposal.I >= 0 && proposal.I <= 30 * (1 + 1e-12));
      assert.ok(Number.isFinite(proposal.score) && proposal.score >= 0);
      assert.ok(!baselineRows.some(row => relative(proposal.S, row.S) < 1e-7 &&
        Math.abs(proposal.I - row.I) <= 1e-7 * Math.max(Math.abs(proposal.I), Math.abs(row.I), Number.MIN_VALUE)));
    }
    for (let j = 1; j < baseline.design.length; j++) assert.ok(baseline.design[j].score <= baseline.design[j - 1].score + 1e-12);
  });
  const scaledCsv = makeCsv(baselineRows.map(row => ({S: row.S * 1e-6, I: row.I * 1e-6, v: row.v * 1e-9})));
  const scaled = await analyze(scaledCsv, [4e-6, 120e-6, 30e-6]);
  check('Changing concentration/rate units preserves model ranking', () =>
    assert.deepEqual(scaled.models.map(m => m.id), baseline.models.map(m => m.id)));
  check('Changing units rescales kinetic parameters consistently', () => {
    for (const reference of baseline.models) {
      const model = scaled.models.find(m => m.id === reference.id);
      for (const key of Object.keys(reference.params)) {
        const factor = key === 'Vmax' ? 1e-9 : 1e-6;
        assert.ok(relative(model.params[key] / factor, reference.params[key]) < 0.005, `${model.id}.${key}`);
      }
    }
  });
  check('Molar-scale design remains nonempty and approximately unit-equivariant', () => {
    assert.equal(scaled.design.length, 8);
    assert.ok(relative(scaled.design[0].S / 1e-6, baseline.design[0].S) < 1e-6);
    assert.ok(relative(scaled.design[0].I / 1e-6, baseline.design[0].I) < 1e-6);
    assert.ok(relative(scaled.design[0].score, baseline.design[0].score) < 0.005);
  });

  const weak = await analyze(await readFile(new URL('weak-inhibition-noisy.csv', fixtureDir), 'utf8'));
  check('Weak inhibition produces limited/ambiguous/tentative evidence', () =>
    assert.ok(['limited', 'ambiguous', 'tentative'].includes(weak.diagnostics.status)));
  const none = await analyze(makeCsv(baselineRows.map(row => ({ ...row, v: 120 * row.S / (35 + row.S) }))));
  check('No inhibition does not produce an unqualified confident mechanism', () =>
    assert.ok(['limited', 'ambiguous', 'tentative'].includes(none.diagnostics.status)));
  const negative = await analyze(makeCsv(baselineRows.map((row, j) => ({...row, v: j ? row.v : -0.5}))));
  check('Negative measured rates are retained and flagged', () => {
    assert.equal(negative.data[0].v, -0.5);
    assert.ok(negative.diagnostics.warnings.some(w => /negative/i.test(w)));
  });
  const invalidCases = [
    ['missing column', baselineCsv.replace('S,I,v', 'S,I,rate'), /Required columns/],
    ['non-numeric row', baselineCsv.replace(/\n[^\n]+/, '\n2,0,missing'), /Invalid data/],
    ['zero substrate', makeCsv(baselineRows.map((row, j) => ({...row, S: j ? row.S : 0}))), /Invalid data/],
    ['negative inhibitor', makeCsv(baselineRows.map((row, j) => ({...row, I: j ? row.I : -1}))), /Invalid data/],
    ['insufficient rows', makeCsv(baselineRows.slice(0, 11)), /At least 12/],
    ['no inhibitor variation', makeCsv(baselineRows.map(row => ({...row, I: 0}))), /distinct inhibitor/],
    ['invalid design bounds', baselineCsv, /Experiment bounds/, [120, 4, 30]],
  ];
  for (const [name, csv, expected, bounds] of invalidCases) {
    await assert.rejects(() => analyze(csv, bounds), expected);
    checks.push({name: `Validation: ${name}`, passed: true});
  }

  const extra = new URL('science-regression.R', import.meta.url);
  try {
    const regression = await readFile(extra, 'utf8');
    await webR.evalRVoid(regression);
    checks.push({name: 'Independent R science-regression.R', passed: true});
    console.log('PASS independent R science-regression.R');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const result = { passed: true, runtime: { webR: webR.version, R: rVersion },
    checks: checks.length, durationSeconds: (Date.now() - started) / 1000,
    fixtures, details: checks,
    interpretation: 'Computational regression results on synthetic fixtures; not validation of experimental mechanisms.' };
  await writeFile(new URL('engine-test-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(`PASS ${checks.length} checks; ${result.durationSeconds}s total`);
} catch (error) {
  console.error('FAIL', error);
  await writeFile(new URL('engine-test-results.json', import.meta.url), JSON.stringify({
    passed: false, completedChecks: checks.length, error: String(error),
    fixtures, details: checks, durationSeconds: (Date.now() - started) / 1000 }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  webR.close();
}
