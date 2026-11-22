/** Re-run the actual browser-downloaded self-contained R script and compare
 * its output with the machine-readable JSON in the actual downloaded report.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let modulePath = process.env.WEBR_MODULE;
if (!modulePath) {
  const local = new URL('../../../work/runtime/node_modules/webr/dist/webr.cjs', import.meta.url);
  try { await access(local); modulePath = fileURLToPath(local); } catch { modulePath = 'webr'; }
}
const { WebR } = require(modulePath);
const r = new WebR({ interactive: false });
const started = Date.now();
const checks = [];
const pass = (name, test) => { test(); checks.push(name); };
const decodeHtml = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const near = (a, b) => Math.abs(a - b) <= 1e-8 * Math.max(Math.abs(a), Math.abs(b), 1e-10);
try {
  const script = await readFile(new URL('../examples/example-analysis.R', import.meta.url), 'utf8');
  const report = await readFile(new URL('../examples/example-report.html', import.meta.url), 'utf8');
  const encoded = report.match(/<summary>Machine-readable analysis JSON<\/summary><pre>([\s\S]*?)<\/pre>/);
  assert.ok(encoded, 'Report contains embedded analysis JSON');
  const browser = JSON.parse(decodeHtml(encoded[1]));
  pass('Downloaded HTML report contains valid named analysis JSON', () => {
    assert.equal(browser.n, 96); assert.equal(browser.conditions, 32);
    assert.equal(browser.models[0].id, 'mixed');
    assert.equal(browser.models.length, 4);
    assert.deepEqual(Object.keys(browser.models[0].params), ['Vmax', 'Km', 'Kis', 'Kii']);
  });
  await r.init();
  await r.evalRVoid(script);
  const reproduced = JSON.parse(await r.evalRString('result_json'));
  const cwd = await r.evalRString('getwd()');
  const jsonFile = await r.FS.readFile(cwd + '/kinetic-results.json');
  const written = JSON.parse(new TextDecoder().decode(jsonFile));
  pass('Exported script writes valid kinetic-results.json without external packages', () =>
    assert.deepEqual(written, reproduced));
  pass('Exported script reproduces input observations and model ordering', () => {
    assert.deepEqual(reproduced.data, browser.data);
    assert.deepEqual(reproduced.models.map(m => m.id), browser.models.map(m => m.id));
  });
  let maximumRelativeParameterDifference = 0;
  pass('Exported script reproduces all fitted kinetic parameters within 1e-8 relative tolerance', () => {
    for (let j = 0; j < browser.models.length; j++) {
      for (const [key, value] of Object.entries(browser.models[j].params)) {
        const actual = reproduced.models[j].params[key];
        maximumRelativeParameterDifference = Math.max(maximumRelativeParameterDifference,
          Math.abs(actual - value) / Math.max(Math.abs(value), 1e-100));
        assert.ok(near(actual, value), `${browser.models[j].id}.${key}: ${actual} vs ${value}`);
      }
    }
  });
  pass('Exported script reproduces AICc evidence and RMSE values', () => {
    for (let j = 0; j < browser.models.length; j++) {
      for (const key of ['aicc', 'delta', 'weight', 'rmse', 'cvRmse'])
        assert.ok(near(reproduced.models[j][key], browser.models[j][key]), `${browser.models[j].id}.${key}`);
    }
  });
  pass('Exported script reproduces proposed experimental conditions and scores', () => {
    assert.equal(reproduced.design.length, browser.design.length);
    for (let j = 0; j < browser.design.length; j++) for (const key of ['S', 'I', 'score'])
      assert.ok(near(reproduced.design[j][key], browser.design[j][key]), `design ${j}.${key}`);
  });
  const result = {
    passed: true, checks: checks.length, details: checks,
    runtime: { webR: r.version, R: await r.evalRString('R.version.string') },
    source: { R: 'examples/example-analysis.R', report: 'examples/example-report.html' },
    n: reproduced.n, conditions: reproduced.conditions,
    preferredModel: reproduced.models[0].id, parameters: reproduced.models[0].params,
    runnerUpDeltaAicc: reproduced.models[1].delta,
    maximumRelativeParameterDifference, tolerance: 1e-8,
    durationSeconds: (Date.now() - started) / 1000,
    interpretation: 'Actual browser-downloaded R script independently re-executed; computational reproducibility of this synthetic example.'
  };
  await writeFile(new URL('export-test-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  await writeFile(new URL('export-test-results.json', import.meta.url), JSON.stringify({
    passed: false, completedChecks: checks, error: String(error), durationSeconds: (Date.now() - started) / 1000
  }, null, 2) + '\n');
  process.exitCode = 1;
} finally { r.close(); }
