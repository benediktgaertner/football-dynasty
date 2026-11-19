// Kalibrierung der Spielerentwicklung (docs/DEVELOPMENT.md): node scripts/dev-calibrate.mjs (nach npm run build -w packages/shared)
import * as S from '../packages/shared/dist/index.js';
const rng = S.createRng ? S.createRng('cal') : null;
const R = S.createRng('calib-1');
const gauss = () => { let u=0,v=0; while(!u) u=Math.random(); v=Math.random(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); };
const ovrOf = (kind,pos,a) => kind==='goalkeeper' ? S.goalkeeperOverall(a) : S.outfieldOverall(a,pos);
function season(p, {train=0, starts=1}) {
  // p: {kind,pos,age,attrs,pot,xp}
  let a = p.attrs, xp = p.xp; const start = ovrOf(p.kind,p.pos,a);
  const focus = p.kind==='goalkeeper' ? 'defense' : (['ST','CF','LW','RW'].includes(p.pos)?'offense': ['CB','CDM'].includes(p.pos)?'defense':'technique');
  for (let w=0; w<38; w++) {
    const ovr = ovrOf(p.kind,p.pos,a); const m = S.devMultiplier(p.age, ovr, p.pot, a.gameIntelligence);
    if (Math.random() < train) { const sh = S.trainingShares(p.kind,p.pos,focus); const g={}; for (const [k,v] of Object.entries(sh)) g[k]=v*S.DEV_TRAINING_XP*m; ({attrs:a,xp}=S.applyXp(a,xp,g)); }
    if (w<37 && Math.random()<starts) {
      const r = Math.max(3, Math.min(10, 6.2 + 1.05*gauss()));
      const isAtt=['ST','CF','LW','RW','CAM'].includes(p.pos);
      const line={minutes:85,rating:r,goals: isAtt&&Math.random()<0.3?1:0, assists: Math.random()<0.12?1:0, tacklesWon: p.kind==='goalkeeper'?0:Math.round(Math.random()*1.0), interceptions: Math.round(Math.random()*0.8), saves: p.kind==='goalkeeper'?Math.round(Math.random()*4):0};
      const g = Object.fromEntries(Object.entries(S.matchXp(p.kind,p.pos,line)).map(([k,v])=>[k,v*m])); ({attrs:a,xp}=S.applyXp(a,xp,g));
    }
  }
  const mid = ovrOf(p.kind,p.pos,a);
  p.age++;
  const u=Math.random(); const d=S.declineAttrs(a,p.age,u,()=>Math.random()); a={...a}; for (const [k,v] of Object.entries(d)) a[k]+=v;
  p.attrs=a; p.xp=xp; return {start, mid, end: ovrOf(p.kind,p.pos,a)};
}
function mk(pos, ovr, age, pot) { const kind=pos==='GK'?'goalkeeper':'outfield'; const attrs = kind==='goalkeeper'? S.generateGoalkeeperAttributes(R, ovr): S.generateOutfieldAttributes(R,pos,ovr); return {kind,pos,age,attrs,pot,xp:{}}; }
const N=400;
const cases=[
  ['18J 66 Pot 84 ST, Stamm, Training jede Woche', 'ST',66,18,84,1,1],
  ['18J 66 Pot 84 ST, Stamm, kein Training', 'ST',66,18,84,0,1],
  ['18J 66 Pot 84 ST, Bank (25%), Training', 'ST',66,18,84,1,0.25],
  ['21J 72 Pot 80 CM, Stamm, Training', 'CM',72,21,80,1,1],
  ['21J 72 Pot 80 CM, Stamm, ohne', 'CM',72,21,80,0,1],
  ['25J 78 Pot 80 CB, Stamm, Training', 'CB',78,25,80,1,1],
  ['25J 78 Pot 80 CB, Stamm, ohne', 'CB',78,25,80,0,1],
  ['27J 80 Pot 80 CB, Stamm, Training', 'CB',80,27,80,1,1],
  ['29J 80 Pot 81 LW, Stamm, Training', 'LW',80,29,81,1,1],
  ['31J 79 Pot 79 ST, Stamm, ohne', 'ST',79,31,79,0,1],
  ['33J 77 Pot 77 CM, Stamm, ohne', 'CM',77,33,77,0,1],
  ['20J 68 Pot 82 GK, Stamm, Training', 'GK',68,20,82,1,1],
  ['30J 80 Pot 80 GK, Stamm, ohne', 'GK',80,30,80,0,1],
];
console.log('Fall | Δ in der Saison (Ø, P10–P90) | Δ Alterung | Δ gesamt');
for (const [name,pos,ovr,age,pot,train,starts] of cases) {
  const ins=[],dec=[],tot=[];
  for (let i=0;i<N;i++){ const p=mk(pos,ovr,age,pot); const r=season(p,{train,starts}); ins.push(r.mid-r.start); dec.push(r.end-r.mid); tot.push(r.end-r.start); }
  const mean=a=>(a.reduce((s,v)=>s+v,0)/a.length).toFixed(2); const q=(a,f)=>a.slice().sort((x,y)=>x-y)[Math.floor(f*a.length)];
  console.log(`${name} | +${mean(ins)} (${q(ins,.1)}…${q(ins,.9)}) | ${mean(dec)} | ${mean(tot)}`);
}
// Karriere
const traj=[]; const p=mk('ST',64,18,84); for(let y=0;y<17;y++){ const r=season(p,{train: 0.8, starts: y<1?0.4:1}); traj.push(`${p.age-1}:${r.start}→${r.end}`);} console.log('Karriere Talent ST (Pot 84):', traj.join(' '));
const traj2=[]; const p2=mk('CM',72,24,74); for(let y=0;y<13;y++){ const r=season(p2,{train: 0.3, starts: 1}); traj2.push(`${p2.age-1}:${r.start}→${r.end}`);} console.log('Karriere Durchschnitt CM (Pot 74):', traj2.join(' '));
