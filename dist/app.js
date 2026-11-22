const $ = (id) => document.getElementById(id);
const names = { competitive: 'Competitive', uncompetitive: 'Uncompetitive', noncompetitive: 'Noncompetitive', mixed: 'Mixed' };
const modelIds = Object.keys(names);
const colors = ['#226458', '#b88738', '#477496', '#b36766', '#8175a1'];
const dashes = { competitive: '', uncompetitive: '7 4', noncompetitive: '2 4', mixed: '10 3 2 3' };
const state = { webR: null, source: '', ready: false, busy: false, result: null, analyzedCSV: '', challenge: null, selected: new Set(), activeModel: null, label: 'No dataset loaded' };
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = (n, digits = 3) => n == null || !Number.isFinite(Number(n)) ? '—' : (n !== 0 && (Math.abs(n) < .001 || Math.abs(n) >= 100000) ? Number(n).toExponential(2) : Number(n).toLocaleString('en-US', { maximumFractionDigits: digits }));
const units = () => ({ S: $('s-unit').value.trim() || 'concentration units', I: $('i-unit').value.trim() || 'concentration units', v: $('v-unit').value.trim() || 'rate units' });
function message(text, kind = '') { $('app-message').textContent = text; $('app-message').className = `app-message ${kind}`; }
function runtime(text, loading = false, error = false) { $('runtime-status').innerHTML = `<span class="status-dot ${loading ? 'loading' : error ? 'error' : ''}" aria-hidden="true"></span>${esc(text)}`; }
function controls() {
  $('run-analysis').disabled = !state.ready || state.busy;
  $('recommend').disabled = !state.result || !state.ready || state.busy;
  $('download-report').disabled = !state.result || state.busy;
  $('download-r').disabled = !state.source || !state.result || state.busy;
  $('download-data').disabled = !$('csv-input').value.trim();
  $('copy-r').disabled = !state.source;
  $('download-source').disabled = !state.source;
  $('reveal-challenge').disabled = !state.challenge || state.busy;
  for (const id of ['load-example','csv-input','csv-file','new-challenge','s-min','s-max','i-max']) $(id).disabled = state.busy;
}
function tab(name, scroll = false) {
  document.querySelectorAll('[data-tab]').forEach(b => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
  document.querySelectorAll('[data-panel]').forEach(p => p.hidden = p.dataset.panel !== name);
  if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.querySelectorAll('[data-tab]').forEach((b, i, all) => {
  b.addEventListener('click', () => tab(b.dataset.tab));
  b.addEventListener('keydown', e => { if (['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) { e.preventDefault(); const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length; tab(all[j].dataset.tab); all[j].focus(); } });
});

// Deterministic simulated initial rates. Truth is never sent to the R fitter.
function random(seed) { let a = seed >>> 0; return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function predict(model, p, S, I) {
  if (model === 'competitive') return p.Vmax*S/(p.Km*(1+I/p.Ki)+S);
  if (model === 'uncompetitive') return p.Vmax*S/(p.Km+S*(1+I/p.Ki));
  if (model === 'noncompetitive') return p.Vmax*S/((p.Km+S)*(1+I/p.Ki));
  return p.Vmax*S/(p.Km*(1+I/p.Kis)+S*(1+I/p.Kii));
}
function simulate(model, seed, difficulty = 'medium') {
  const rng = random(seed); const p = { Vmax: 120, Km: 35, ...(model === 'mixed' ? { Kis: 12, Kii: 65 } : { Ki: 18 }) };
  const Svals = difficulty === 'high' ? [8,12,18,25] : [3,7,15,30,60,120,240,480];
  const Ivals = difficulty === 'high' ? [0,3,6] : [0,6,18,54];
  const noise = { low: .35, medium: 2, high: 5 }[difficulty];
  const normal = () => Math.sqrt(-2*Math.log(Math.max(rng(),1e-12))) * Math.cos(2*Math.PI*rng());
  const rows = [];
  for (const S of Svals) for (const I of Ivals) for(let r=0;r<3;r++) rows.push({ S, I, v: predict(model,p,S,I) + noise*normal() });
  return { model, params: p, seed, difficulty, noise, csv: 'S,I,v\n'+rows.map(d=>`${d.S},${d.I},${d.v.toFixed(7)}`).join('\n') };
}

// Preview parser supports CSV quoted fields. R performs authoritative validation.
function parseCSV(text) {
  const rows=[]; let row=[], field='', quoted=false;
  const input=text.replace(/^\uFEFF/,'');
  for(let i=0;i<=input.length;i++) { const c=input[i];
    if(quoted) { if(c==='"'&&input[i+1]==='"'){field+='"';i++;} else if(c==='"')quoted=false; else if(c!==undefined)field+=c; }
    else if(c==='"'&&field==='')quoted=true;
    else if(c===','){row.push(field.trim());field='';}
    else if(c==='\n'||c===undefined){row.push(field.trim());if(row.some(x=>x!==''))rows.push(row);row=[];field='';}
    else if(c!=='\r')field+=c;
  }
  if(!rows.length)return [];
  const h=rows.shift(); const ix=['S','I','v'].map(x=>h.indexOf(x));
  if(ix.some(x=>x<0))return [];
  return rows.map(r=>Object.fromEntries(['S','I','v'].map((k,j)=>[k,r[ix[j]]===''||r[ix[j]]===undefined?NaN:Number(r[ix[j]])])));
}
function preview() {
  const rows=parseCSV($('csv-input').value); const valid=rows.filter(d=>[d.S,d.I,d.v].every(Number.isFinite));
  $('data-summary').innerHTML=rows.length?`<span><strong>${rows.length}</strong> observations</span><span><strong>${new Set(valid.map(d=>d.S)).size}</strong> [S] levels</span><span><strong>${new Set(valid.map(d=>d.I)).size}</strong> [I] levels</span>`:'<span>Use the column headers S, I, v</span>';
  $('data-preview').innerHTML=rows.length?`<table><thead><tr><th>Row</th><th>[S]</th><th>[I]</th><th>Initial rate</th></tr></thead><tbody>${rows.slice(0,120).map((d,i)=>`<tr><td>${i+1}</td><td>${fmt(d.S)}</td><td>${fmt(d.I)}</td><td>${fmt(d.v)}</td></tr>`).join('')}</tbody></table>${rows.length>120?'<p class="field-help">Showing the first 120 observations. All rows are included in analysis.</p>':''}`:'<p class="muted">Your imported measurements will appear here.</p>';
  controls();
  if(!state.result && valid.length) renderKinetics(valid);
}
const emptyHTML = {};
for (const id of ['kinetics-chart','model-toggles','evidence-summary','model-ranking','parameter-table','residual-chart','design-results']) emptyHTML[id]=$(id).innerHTML;
function invalidate(clearChallenge = true) {
  state.result=null;state.analyzedCSV='';
  if(clearChallenge){state.challenge=null;$('challenge-result').innerHTML='';$('challenge-note').textContent='The mechanism and parameters remain hidden until you choose to reveal them.';}
  for(const [id,html] of Object.entries(emptyHTML))$(id).innerHTML=html;
  controls();
}
function loadCSV(csv,label,clearChallenge=true) { invalidate(clearChallenge);$('csv-input').value=csv;state.label=label;preview();message(`${label} loaded. Compare the models when you are ready.`); }
$('csv-input').addEventListener('input',()=>{invalidate();state.label='Pasted measurements';preview();message('Data changed. Run the comparison to update the results.');});
$('load-example').addEventListener('click',()=>{const sim=simulate('mixed',73,'medium');loadCSV(sim.csv,'Example: simulated mixed inhibition');});
$('csv-file').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;if(f.size>1_000_000){message('Please choose a CSV smaller than 1 MB.','error');return;}loadCSV(await f.text(),f.name);e.target.value='';});

function bounds() { const b=[$('s-min'),$('s-max'),$('i-max')].map(e=>Number(e.value));if(b.some(x=>!Number.isFinite(x))||b[0]<=0||b[1]<=b[0]||b[2]<=0)throw new Error('Use bounds with 0 < minimum [S] < maximum [S], and maximum [I] > 0.');return b; }
async function analyze() {
  if(!state.ready||state.busy)return;
  let b;try{b=bounds();}catch(e){message(e.message,'error');return;}
  const csv=$('csv-input').value;
  state.busy=true;controls();runtime('Fitting four models',true);message('R is fitting all four models, checking uncertainty, and comparing next-experiment conditions.');
  const oldButton=$('run-analysis').innerHTML;$('run-analysis').innerHTML='<span class="spinner" aria-hidden="true"></span> Comparing models…';
  try {
    await state.webR.FS.writeFile('/home/web_user/kinetic.csv',new TextEncoder().encode(csv));
    const json=await state.webR.evalRString(`ed_analyze(paste(readLines('/home/web_user/kinetic.csv', warn = FALSE), collapse = '\\n'), ${b.join(', ')})`);
    const result=JSON.parse(json);state.result=result;state.analyzedCSV=csv;state.activeModel=result.models[0].id;state.selected=new Set([state.activeModel]);
    renderAll();message(`Analysis complete · ${result.n} observations · ${result.conditions} concentration pairs · R ${result.rVersion}.`,'success');
    if(state.challenge) $('challenge-note').textContent='Analysis complete. Record your conclusion, then reveal the hidden mechanism.';
  } catch(e) { state.result=null;for(const [id,html]of Object.entries(emptyHTML))$(id).innerHTML=html;preview();message(String(e.message||e).replace(/^Error(?: in unknown source)?:\s*/,''),'error'); }
  finally {state.busy=false;controls();runtime(`R engine ready`);$('run-analysis').innerHTML=oldButton;}
}
$('run-analysis').addEventListener('click',analyze);$('recommend').addEventListener('click',analyze);

function chartFrame({ width=880,height=400,xmin=0,xmax=1,ymin=0,ymax=1,xlabel='',ylabel='',content='',zero=false }) {
  const m={l:76,r:25,t:24,b:56};const w=width-m.l-m.r,h=height-m.t-m.b;
  const x=n=>m.l+(n-xmin)/(xmax-xmin)*w,y=n=>m.t+(ymax-n)/(ymax-ymin)*h;
  let grid='';
  for(let j=0;j<=5;j++){let v=ymin+(ymax-ymin)*j/5;grid+=`<path d="M${m.l},${y(v)}H${width-m.r}" stroke="#e1e7dc" stroke-dasharray="3 5"/><text x="${m.l-10}" y="${y(v)+4}" text-anchor="end" fill="#81917d" font-size="11">${esc(fmt(v,1))}</text>`;}
  for(let j=0;j<=5;j++){let v=xmin+(xmax-xmin)*j/5;grid+=`<text x="${x(v)}" y="${height-m.b+23}" text-anchor="middle" fill="#81917d" font-size="11">${esc(fmt(v,1))}</text>`;}
  if(zero&&ymin<0&&ymax>0)grid+=`<path d="M${m.l},${y(0)}H${width-m.r}" stroke="#899787" stroke-dasharray="5 4"/>`;
  return {x,y,svg:`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(ylabel)} versus ${esc(xlabel)}"><defs><clipPath id="clip-${zero?'residual':'kinetics'}"><rect x="${m.l}" y="${m.t}" width="${w}" height="${h}"/></clipPath></defs>${grid}<path d="M${m.l},${m.t}V${height-m.b}H${width-m.r}" fill="none" stroke="#b1c0ae"/><g clip-path="url(#clip-${zero?'residual':'kinetics'})">${content}</g><text x="${m.l+w/2}" y="${height-8}" text-anchor="middle" fill="#6d8067" font-size="12">${esc(xlabel)}</text><text x="17" y="${m.t+h/2}" transform="rotate(-90 17 ${m.t+h/2})" text-anchor="middle" fill="#6d8067" font-size="12">${esc(ylabel)}</text></svg>`};
}
function renderKinetics(data=state.result?.data) {
  if(!data?.length)return;
  const result=state.result;const u=units();const levels=[...new Set(data.map(d=>d.I))].sort((a,b)=>a-b);
  const curves=(result?.curves||[]).filter(c=>state.selected.has(c.model));
  const vals=[...data.map(d=>d.v),...curves.flatMap(c=>c.points.map(p=>p.v))];
  const ymin=Math.min(0,...vals), ymax=Math.max(...vals,1e-30);const span=Math.max(ymax-ymin,Math.abs(ymax)*.1,1e-30);
  const spec={width:Math.max(320,$('kinetics-chart').clientWidth||880),height:360,xmin:0,xmax:Math.max(...data.map(d=>d.S))*1.04,ymin:ymin-.03*span,ymax:ymax+.09*span,xlabel:`Substrate [S] (${u.S})`,ylabel:`Initial rate (${u.v})`};
  const {x,y}=chartFrame(spec);let content='';
  for(const c of curves){const col=colors[levels.indexOf(c.I)%colors.length];content+=`<path d="${c.points.map((p,i)=>`${i?'L':'M'}${x(p.S)},${y(p.v)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="${dashes[c.model]}" opacity=".88"><title>${esc(names[c.model])}, [I] = ${esc(c.I)}</title></path>`;}
  for(const d of data) content+=`<circle cx="${x(d.S)}" cy="${y(d.v)}" r="3.1" fill="${colors[levels.indexOf(d.I)%colors.length]}" stroke="#fffefa" stroke-width=".8" opacity=".75"><title>[S] ${esc(fmt(d.S))}; [I] ${esc(fmt(d.I))}; v ${esc(fmt(d.v))}</title></circle>`;
  $('kinetics-chart').innerHTML=chartFrame({...spec,content}).svg+`<div class="chart-legend inhibitor-legend">${levels.map((iv,j)=>`<span class="legend-item"><i class="legend-swatch" style="background:${colors[j%colors.length]}"></i>[I] ${esc(fmt(iv))} ${esc(u.I)}</span>`).join('')}</div>`;
}
function renderToggles(){ $('model-toggles').innerHTML=state.result.models.map(m=>`<button type="button" data-model="${m.id}" class="${state.selected.has(m.id)?'active':''}" aria-pressed="${state.selected.has(m.id)}">${esc(m.name)}</button>`).join('');$('model-toggles').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{state.selected.has(b.dataset.model)?state.selected.delete(b.dataset.model):state.selected.add(b.dataset.model);renderToggles();renderKinetics();})); }
function renderEvidence(){const r=state.result,m=r.models[0];$('evidence-summary').innerHTML=`<div class="summary-intro"><span class="small-label">READ THE EVIDENCE</span><h2>${esc(r.diagnostics.headline)}</h2><p class="support-detail">${esc(r.diagnostics.detail)}</p></div><div class="metric"><span class="metric-value">${fmt(m.weight*100,1)}<small>%</small></span><span class="metric-label">Relative model weight</span></div><div class="metric"><span class="metric-value">${fmt(r.models[1].delta,2)}</span><span class="metric-label">ΔAICc to next model</span></div>`;}
function renderRanking(){const r=state.result;const u=units();$('model-ranking').className='table-wrap';$('model-ranking').innerHTML=`<table><thead><tr><th>Model</th><th>ΔAICc</th><th>Weight</th><th>RMSE</th><th>Holdout</th></tr></thead><tbody>${r.models.map(m=>`<tr class="${m.id===state.activeModel?'selected-row':''}"><td><button class="model-link" data-view="${m.id}" type="button">${esc(m.name)}${m.id===r.models[0].id?'<span class="best-tag">LEADING</span>':''}</button></td><td>${fmt(m.delta,2)}</td><td><div class="weight-cell"><span>${fmt(m.weight*100,1)}%</span><i style="width:${Math.max(m.weight*65,1)}px"></i></div></td><td>${fmt(m.rmse,3)}</td><td>${fmt(m.cvRmse,3)}</td></tr>`).join('')}</tbody></table><p class="field-help">Errors in ${esc(u.v)}. Holdout = one fixed split by concentration pair; not repeated cross-validation. Lower errors are better.</p><details class="fit-details"><summary>Fit checks and assumptions</summary><ul class="diagnostic-notes">${r.diagnostics.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul>${r.models.map(m=>m.warnings.length?`<p class="field-help"><strong>${esc(m.name)}:</strong> ${esc(m.warnings.join(' '))}</p>`:'').join('')}</details>`;
  $('model-ranking').querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{state.activeModel=b.dataset.view;state.selected=new Set([state.activeModel]);renderRanking();renderParameters();renderResiduals();renderToggles();renderKinetics();}));}
function renderParameters(){const r=state.result,m=r.models.find(m=>m.id===state.activeModel);const u=units();$('parameter-table').className='table-wrap';$('parameter-table').innerHTML=`<label class="field-label" for="parameter-model">Inspect a model</label><select id="parameter-model" class="model-select">${r.models.map(k=>`<option value="${k.id}" ${k.id===m.id?'selected':''}>${esc(k.name)}</option>`).join('')}</select><table><thead><tr><th>Parameter</th><th>Estimate</th><th>Approx. 95% interval</th></tr></thead><tbody>${Object.entries(m.params).map(([k,v])=>`<tr><td><strong>${esc(k)}</strong><small class="parameter-unit">${esc(k==='Vmax'?u.v:k==='Km'?u.S:u.I)}</small></td><td>${fmt(v)}</td><td>${m.ci[k]?.every(x=>x!=null)?`${fmt(m.ci[k][0])} – ${fmt(m.ci[k][1])}`:'Not identified'}</td></tr>`).join('')}</tbody></table><p class="parameter-note">${esc(m.ciMethod)}. These local intervals can be unreliable for weakly identified models.</p>${m.warnings.length?`<div class="warning-box">${m.warnings.map(esc).join('<br>')}</div>`:''}`;$('parameter-model').addEventListener('change',e=>{state.activeModel=e.target.value;state.selected=new Set([state.activeModel]);renderRanking();renderParameters();renderResiduals();renderToggles();renderKinetics();});}
function renderResiduals(){const r=state.result,m=r.models.find(m=>m.id===state.activeModel),u=units();const vals=m.residuals,span=Math.max(...vals.map(Math.abs),1e-30);const spec={width:Math.max(320,$('residual-chart').clientWidth||1000),height:255,xmin:0,xmax:Math.max(...m.predictions)*1.05,ymin:-span*1.2,ymax:span*1.2,xlabel:`Fitted initial rate (${u.v}) · ${m.name}`,ylabel:`Residual (${u.v})`,zero:true};const {x,y}=chartFrame(spec);const levels=[...new Set(r.data.map(d=>d.I))].sort((a,b)=>a-b);const content=vals.map((v,j)=>`<circle cx="${x(m.predictions[j])}" cy="${y(v)}" r="3.4" fill="${colors[levels.indexOf(r.data[j].I)%colors.length]}" opacity=".75"><title>Row ${j+1}: fitted ${fmt(m.predictions[j])}, residual ${fmt(v)}</title></circle>`).join('');$('residual-chart').className='residual-plot';$('residual-chart').innerHTML=chartFrame({...spec,content}).svg;}
function renderDesign(){const r=state.result,u=units();$('design-results').className='design-results';$('design-results').innerHTML=`<span class="small-label">WHERE THE LEADING MODELS DISAGREE</span><p class="design-models">${r.designInfo.models.map(id=>esc(names[id])).join(' vs. ')}</p><div class="table-wrap"><table><thead><tr><th>[S] (${esc(u.S)})</th><th>[I] (${esc(u.I)})</th><th>Separation score</th><th>Predicted rates</th></tr></thead><tbody>${r.design.slice(0,5).map((d,i)=>`<tr><td>${fmt(d.S)}${i===0?'<span class="best-tag">TOP</span>':''}</td><td>${fmt(d.I)}</td><td>${fmt(d.score,2)}</td><td>${Object.entries(d.predictions).map(([id,v])=>`<span class="prediction-line">${esc(names[id])}: ${fmt(v)}</span>`).join('')}${d.extrapolation?'<span class="extrapolation-label">Extrapolation</span>':''}</td></tr>`).join('')}</tbody></table></div><p class="field-help">${esc(r.designInfo.method)}</p><p class="field-help">${esc(r.designInfo.limitation)}</p>${!r.designInfo.runnerUpPlausible?'<div class="alert info">The second model currently has little relative support. These suggestions test that alternative rather than resolve a close contest.</div>':''}${Math.max(...r.design.map(d=>d.score))<.1?'<div class="warning-box">The leading models make very similar predictions within these bounds. This concentration grid may not distinguish them.</div>':''}`;}
function renderAll(){renderEvidence();renderToggles();renderKinetics();renderRanking();renderParameters();renderResiduals();renderDesign();}
window.addEventListener('resize',()=>{if(!$('workspace-panel').hidden){if(state.result){renderKinetics();renderResiduals();}else preview();}});
for(const id of ['s-unit','i-unit','v-unit'])$(id).addEventListener('change',()=>{if(state.result)renderAll();else preview();});

$('new-challenge').addEventListener('click',()=>{const seed=Number($('challenge-seed').value);if(!Number.isInteger(seed)||seed<1||seed>2147483646){$('challenge-note').textContent='Choose an integer seed between 1 and 2147483646.';return;}const difficulty=$('challenge-difficulty').value;const rng=random(seed^0x91E10DA5);const model=modelIds[Math.floor(rng()*4)];const sim=simulate(model,seed,difficulty);loadCSV(sim.csv,`Blind challenge · seed ${seed}`,true);state.challenge={...sim,revealed:false};$('challenge-note').textContent=`Dataset generated: ${difficulty} difficulty, seed ${seed}. Analyse it in Workspace before revealing the answer.`;controls();tab('workspace',true);});
$('reveal-challenge').addEventListener('click',()=>{const c=state.challenge;if(!c)return;c.revealed=true;const best=state.result?.models[0];$('challenge-result').innerHTML=`<span class="small-label">HIDDEN GROUND TRUTH</span><h3>${esc(names[c.model])} inhibition</h3><p>${Object.entries(c.params).map(([k,v])=>`${esc(k)} = ${fmt(v)}`).join(' · ')}</p><p>Added Gaussian noise SD: ${fmt(c.noise)} rate units. Seed: ${c.seed}.</p>${best?`<p>The fitted leading model was <strong>${esc(best.name)}</strong>. ${best.id===c.model?'It matches the generating model.':'It differs from the generating model.'} Compare its uncertainty and residuals before judging the result.</p>`:'<p>You revealed the answer before fitting. Generate a new seed for another blind test.</p>'}<p class="field-help">Simulation truth is available in browser memory. This is a learning challenge, not a secure examination mode.</p>`;$('challenge-note').textContent='Ground truth revealed. Record what the analysis recovered and what it missed.';});

function download(filename,text,type='text/plain;charset=utf-8'){const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('download-data').addEventListener('click',()=>download(state.challenge?'blind-challenge.csv':'kinetic-data.csv',$('csv-input').value,'text/csv;charset=utf-8'));
$('download-source').addEventListener('click',()=>download('engine.R',state.source));
$('copy-r').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(state.source);$('copy-r').textContent='Copied';setTimeout(()=>$('copy-r').textContent='Copy R code',1500);}catch{message('Clipboard access was unavailable. Use Download R source instead.');}});
function reproducibleR(){const r=state.result;const csv=state.analyzedCSV;const numericCSV=r.data.map(d=>`${d.S},${d.I},${d.v}`).join('\n');return `${state.source}\n\n# Reproduce this analysis. Units are labels, not automatic conversions.\n# Source: ${state.label.replace(/[\r\n]/g,' ')}\n# S: ${units().S.replace(/[\r\n]/g,' ')}; I: ${units().I.replace(/[\r\n]/g,' ')}; v: ${units().v.replace(/[\r\n]/g,' ')}\ninput_csv <- "S,I,v\\n${numericCSV.replace(/\n/g,'\\n')}"\nresult_json <- ed_analyze(input_csv, ${Object.values(r.designInfo.bounds).join(', ')})\nwriteLines(result_json, "kinetic-results.json")\ncat("Saved kinetic-results.json\\n")\n`;}
$('download-r').addEventListener('click',()=>download('kinetic-analysis.R',reproducibleR()));
$('download-report').addEventListener('click',()=>{const r=state.result,u=units();const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KINETIC analysis report</title><style>body{max-width:1000px;margin:40px auto;padding:0 24px;font:15px/1.6 system-ui;color:#163c3d}h1{font:40px Georgia}table{border-collapse:collapse;width:100%;margin:20px 0}td,th{padding:9px;border-bottom:1px solid #dce2d8;text-align:left}svg{width:100%;height:auto}.muted{color:#65766b}pre{white-space:pre-wrap;background:#f2f4ee;padding:20px}button,select,.model-select,label{display:none}button.model-link{display:inline;background:none;border:0;color:inherit;font:inherit}.parameter-unit{display:block;font-size:11px}.warning-box{background:#f9eed8;padding:12px}a{color:#226458}</style><h1>KINETIC · Analysis report</h1><p class="muted">${esc(state.label)} · ${new Date().toISOString()} · R ${esc(r.rVersion)} · Engine ${esc(r.engineVersion)}</p><h2>${esc(r.diagnostics.headline)}</h2><p>${esc(r.diagnostics.detail)}</p><p>${r.n} observations; ${r.conditions} concentration pairs. Units: [S] ${esc(u.S)}, [I] ${esc(u.I)}, v ${esc(u.v)}.</p><h2>Observed data and selected model curves</h2>${$('kinetics-chart').innerHTML}<h2>Candidate model comparison</h2>${$('model-ranking').innerHTML}<h2>Parameters: ${esc(names[state.activeModel])}</h2>${$('parameter-table').innerHTML}<h2>Residual diagnostics</h2>${$('residual-chart').innerHTML}<h2>Next experiments</h2>${$('design-results').innerHTML}<h2>Assumptions</h2><ul>${Object.values(r.assumptions).map(s=>`<li>${esc(s)}</li>`).join('')}</ul><p><a href="https://www.ncbi.nlm.nih.gov/books/NBK92001/">Assay Guidance Manual: Mechanism of Action Assays for Enzymes</a></p><details><summary>Machine-readable analysis JSON</summary><pre>${esc(JSON.stringify(r,null,2))}</pre></details></html>`;download('kinetic-report.html',html,'text/html;charset=utf-8');});

async function start(){
  try{
    const sourceResponse=await fetch('./engine.R');if(!sourceResponse.ok)throw new Error('R analysis source could not be loaded.');state.source=await sourceResponse.text();$('r-source').textContent=state.source;controls();
    const {WebR,ChannelType}=await import('https://webr.r-wasm.org/v0.6.0/webr.mjs');
    runtime('Downloading R runtime',true);
    state.webR=new WebR({channelType:ChannelType.PostMessage});await state.webR.init();await state.webR.evalRVoid(state.source);state.ready=true;runtime('R engine ready');controls();
  }catch(e){runtime('R unavailable',false,true);message(`The R engine could not start. Check your internet connection and reload. ${e.message||e}`,'error');}
}
preview();start();
