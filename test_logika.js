// Samostatný test čisté logiky panelu „Budova“ (bez prohlížeče, bez knihoven).
// Spuštění (ze složky repozitáře): node test_logika.js
// Když cokoliv selže, node vypíše AssertionError a skončí s chybovým kódem.
const assert = require('node:assert');
const L = require('./budova-panel.user.js');

// --- převod text ↔ značky (formát textového pole iD: řádky klíč=hodnota) ---
// mezery kolem klíče/hodnoty se ořežou, prázdné řádky se ignorují,
// dělí se jen na PRVNÍM "=" (hodnota smí "=" obsahovat)
assert.deepStrictEqual(L.parseTagText('building=yes\n\n height = 25 \nname=a=b'), { building: 'yes', height: '25', name: 'a=b' });
assert.strictEqual(L.serializeTags({ a: '1', b: '2' }), 'a=1\nb=2');

// --- aplikace změn: undefined nebo '' klíč smaže, ostatní přepíše/přidá ---
assert.deepStrictEqual(L.applyChanges({ a: '1', b: '2' }, { b: undefined, c: '3' }), { a: '1', c: '3' });
assert.deepStrictEqual(L.applyChanges({ a: '1' }, { a: '' }), {});

// --- čísla z formuláře: čárka → tečka, jednotka "m" pryč, neplatné → null ---
assert.strictEqual(L.normalizeNumber('7,5'), '7.5');
assert.strictEqual(L.normalizeNumber('25 m'), '25');
assert.strictEqual(L.normalizeNumber('abc'), null);
assert.strictEqual(L.normalizeNumber('-3'), null);
assert.strictEqual(L.normalizeNumber(''), null);

// --- upozornění (jen informují, nic neopravují) ---
const k = t => L.checkWarnings(t).map(w => w.key);
assert.ok(k({ building: 'yes', height: '10', 'roof:height': '12' }).includes('roof:height'));
assert.ok(k({ 'building:part': 'yes', height: '10', min_height: '10' }).includes('min_height'));
assert.ok(k({ building: 'cathedral', 'building:levels': '1', 'building:flats': '1' }).includes('building:flats'));
assert.deepStrictEqual(L.checkWarnings({ building: 'house', height: '9', 'roof:height': '3' }), []);
assert.strictEqual(L.ROOF_SHAPES.length, 12);

// --- boční řez (SVG): obsahuje hodnoty výšek, chybějící výšku přizná, každý tvar má obrys ---
const s = L.svgRez({ building: 'yes', height: '25', 'roof:height': '7', 'roof:shape': 'gabled' });
assert.ok(s.startsWith('<svg') && s.includes('25') && s.includes('7'));
assert.ok(L.svgRez({ building: 'yes' }).includes('výška nezadána'));
for (const r of L.ROOF_SHAPES) assert.ok(L.svgRez({ building: 'yes', height: '10', 'roof:shape': r.value }).includes('<path'), 'tvar ' + r.value);
// hodnoty ze značek se do SVG nesmí dostat jako HTML (escapování)
assert.ok(!L.svgRez({ building: 'yes', height: '10', 'building:colour': '"><script>' }).includes('<script>'));

// --- oprava z revize 1+3: kdy panel NESMÍ zapsat (vrací důvod, jinak null) ---
assert.strictEqual(L.duvodNezapsat('building=yes\nheight=25'), null);
assert.ok(L.duvodNezapsat('building=yes\nbuilding:levels=*'));      // smíšené hodnoty (výběr více prvků)
assert.ok(L.duvodNezapsat('name= Kostel '));                        // mezera na okraji hodnoty
assert.ok(L.duvodNezapsat('name =B\nname=A'));                      // mezera na okraji klíče
assert.strictEqual(L.duvodNezapsat('name=Kostel sv. Jana\n\n'), null); // mezery uvnitř a prázdné řádky jsou v pořádku

// --- oprava z revize 4: upozornění na desetinnou čárku v datech ---
assert.ok(k({ building: 'yes', height: '7,5' }).includes('height'));
assert.ok(k({ building: 'yes', 'building:levels': '2,5' }).includes('building:levels'));

// --- oprava z revize 5: krok podlaží – null = nic nezapisovat ---
assert.strictEqual(L.krokPodlazi(undefined, -1, 'building:levels'), null); // "−" u nevyplněné hodnoty nic
assert.strictEqual(L.krokPodlazi(undefined, 1, 'building:levels'), '1');
assert.strictEqual(L.krokPodlazi('2.5', 1, 'building:levels'), null);    // necelé číslo nepřepisovat
assert.strictEqual(L.krokPodlazi('3;4', 1, 'building:levels'), null);
assert.strictEqual(L.krokPodlazi('1', -1, 'building:levels'), '0');      // building:levels=0 je platné
assert.strictEqual(L.krokPodlazi('1', -1, 'roof:levels'), '');           // roof:levels 0 → smazat ('' = smazat)
assert.strictEqual(L.krokPodlazi('0', -1, 'building:levels'), null);     // pod nulu ne

// ======================= v1.2: předvolby typů a další 3D značky =======================

// --- předvolby: doplní jen prázdné hodnoty, building změní jen z "yes" ---
const pan = L.predvolbaZmeny({ building: 'yes', 'building:levels': '8' }, 'panelak', false);
assert.strictEqual(pan.building, 'apartments');
assert.strictEqual(pan['roof:shape'], 'flat');
assert.strictEqual(pan.height, '22.4');                       // 8 × 2,8 m, plochá střecha bez výšky
const rd = L.predvolbaZmeny({ building: 'house', 'building:levels': '2', 'roof:shape': 'hipped' }, 'rodinny', false);
assert.ok(!('building' in rd));                               // house nepřepisovat
assert.ok(!('roof:shape' in rd));                             // existující tvar nepřepisovat
assert.strictEqual(rd['roof:height'], '4');                   // střecha není plochá → doplnit výšku střechy
assert.strictEqual(rd.height, '10');                          // 2 × 3 + 4
assert.ok(!('height' in L.predvolbaZmeny({ building: 'yes', height: '12', 'building:levels': '3' }, 'rodinny', false)));
// hromadně: klíče se "*" nechat, výšku nepočítat (každá budova má jiná podlaží)
const hrom = L.predvolbaZmeny({ building: 'yes', 'roof:shape': '*', 'building:levels': '*' }, 'panelak', true);
assert.ok(!('roof:shape' in hrom) && !('height' in hrom));
assert.strictEqual(hrom.building, 'apartments');
assert.strictEqual(L.predvolbaZmeny({ building: 'garages' }, 'garaze', false).window, 'no');
assert.deepStrictEqual(L.predvolbaZmeny({ building: 'yes' }, 'neexistuje', false), {});
// část budovy: building se nedoplňuje
assert.ok(!('building' in L.predvolbaZmeny({ 'building:part': 'yes' }, 'panelak', false)));

// --- výška z podlaží a výška patra ---
assert.strictEqual(L.vypoctiVysku({ 'building:levels': '4', 'roof:height': '3', 'roof:shape': 'gabled' }, 3), '15');
assert.strictEqual(L.vypoctiVysku({ 'building:levels': '5' }, 2.8), '14');           // bez střechy = plochá
assert.strictEqual(L.vypoctiVysku({ 'building:levels': '2', 'roof:shape': 'gabled' }, 3), null); // šikmá bez roof:height → nevím
assert.strictEqual(L.vypoctiVysku({ 'building:levels': '2.5' }, 3), null);
assert.strictEqual(L.vypoctiVysku({}, 3), null);
assert.strictEqual(L.vyskaPatra({ height: '12', 'roof:height': '3', 'roof:shape': 'gabled', 'building:levels': '3' }), 3);
assert.strictEqual(L.vyskaPatra({ height: '12', 'building:levels': '0' }), null);
assert.ok(k({ building: 'yes', height: '30', 'building:levels': '3' }).includes('building:levels'));  // 10 m na patro
assert.ok(k({ building: 'yes', height: '5', 'building:levels': '3' }).includes('building:levels'));   // 1,7 m na patro
assert.deepStrictEqual(L.checkWarnings({ building: 'apartments', height: '24', 'building:levels': '8' }), []);

// --- směr pultové střechy ---
assert.strictEqual(L.smerNaStupne('90'), 90);
assert.strictEqual(L.smerNaStupne('SW'), 225);
assert.strictEqual(L.smerNaStupne('NNE'), 22.5);
assert.strictEqual(L.smerNaStupne('blbost'), null);
assert.strictEqual(L.SMERY.length, 8);

// --- bez oken ---
assert.strictEqual(L.bezOken({ windows: 'no' }), true);
assert.strictEqual(L.bezOken({ window: 'yes' }), false);
assert.deepStrictEqual(L.zmenyOkna({}, true), { window: 'no' });
assert.deepStrictEqual(L.zmenyOkna({ window: 'no', windows: 'no' }, false), { window: undefined, windows: undefined });

// --- návrh typu podle značek ---
assert.strictEqual(L.navrhTypu({ building: 'apartments', 'building:levels': '6' }), 'panelak');
assert.strictEqual(L.navrhTypu({ building: 'apartments', 'building:levels': '3' }), 'cihlovy');
assert.strictEqual(L.navrhTypu({ building: 'detached' }), 'rodinny');
assert.strictEqual(L.navrhTypu({ building: 'warehouse' }), 'hala');
assert.strictEqual(L.navrhTypu({ building: 'yes' }), null);

// --- část nad průjezdem: jen prázdné hodnoty ---
assert.deepStrictEqual(L.zmenyPrujezd({ 'building:part': 'yes' }), { min_height: '4', 'building:min_level': '1' });
assert.deepStrictEqual(L.zmenyPrujezd({ 'building:part': 'yes', min_height: '5' }), { 'building:min_level': '1' });

// --- hromadný režim: "*" je povolená, mezery na okraji ne ---
assert.strictEqual(L.duvodNezapsat('building=yes\nroof:shape=*', true), null);
assert.ok(L.duvodNezapsat('building=yes\nroof:shape=*', false));
assert.ok(L.duvodNezapsat('name= X', true));

// ======================= v1.3: živý 3D náhled a otočení střechy =======================

// --- převod px → m: na rovníku při zoomu 0 má pixel ~156 km ---
assert.ok(Math.abs(L.mNaPx(0, 0) - 156543.03) < 0.1);
assert.ok(Math.abs(L.mNaPx(20, 60) - 156543.03 * 0.5 / 1048576) < 1e-6);

// --- půdorys z SVG cesty: osa y míří na sever (v obrazovce dolů = na jih), poslední opakovaný bod pryč ---
const pud = L.pudorysZCesty('M0,0L20,0L20,10L0,10Z', 0.5);
assert.strictEqual(pud.length, 4);
assert.deepStrictEqual(pud[2], [10, -5]);
assert.strictEqual(L.pudorysZCesty('M0 0 L10 0 L10 10 L0 0', 1).length, 3);      // uzavření opakováním 1. bodu

// --- nejmenší obdélník kolem půdorysu: rozměry a směr delší osy ---
const ob = L.obdelnik([[0, 0], [10, 0], [10, 4], [0, 4]]);
assert.ok(Math.abs(ob.delka - 10) < 1e-6 && Math.abs(ob.sirka - 4) < 1e-6);
assert.ok(Math.abs(Math.abs(ob.ux) - 1) < 1e-6);                                 // delší osa ve směru x
const obS = L.obdelnik([[0, 0], [7, 7], [5, 9], [-2, 2]]);                       // natočený obdélník 45°
assert.ok(Math.abs(obS.delka - Math.hypot(7, 7)) < 1e-6 && Math.abs(obS.sirka - Math.hypot(2, 2)) < 1e-6);

// --- 3D model: sedlová střecha, hřeben podél/napříč (osa hřebene se prohodí) ---
const dum = [[0, 0], [10, 0], [10, 4], [0, 4]];
const hreben = m => {                                                             // body ve výšce vrcholu → rozsah v x a y
  const v = m.plochy.flatMap(f => f.body).filter(b => Math.abs(b[2] - 8) < 1e-6);
  return [Math.max(...v.map(b => b[0])) - Math.min(...v.map(b => b[0])), Math.max(...v.map(b => b[1])) - Math.min(...v.map(b => b[1]))];
};
const podel = L.model3d({ building: 'house', height: '8', 'roof:height': '3', 'roof:shape': 'gabled' }, dum);
const napric = L.model3d({ building: 'house', height: '8', 'roof:height': '3', 'roof:shape': 'gabled', 'roof:orientation': 'across' }, dum);
assert.ok(hreben(podel)[0] > 9 && hreben(podel)[1] < 1e-6);                      // hřeben 10 m podél x
assert.ok(hreben(napric)[1] > 3.9 && hreben(napric)[0] < 1e-6);                  // hřeben 4 m podél y
assert.strictEqual(podel.plochy.filter(f => f.druh === 'stena').length, 4);       // 4 stěny

// --- pultová: nejníž na straně, kam stéká voda (roof:direction=180 = na jih = malé y) ---
const pult = L.model3d({ building: 'yes', height: '6', 'roof:height': '2', 'roof:shape': 'skillion', 'roof:direction': '180' }, dum);
const strecha = pult.plochy.find(f => f.druh === 'strecha');
const zJih = Math.max(...strecha.body.filter(b => b[1] === 0).map(b => b[2]));
const zSever = Math.min(...strecha.body.filter(b => b[1] === 4).map(b => b[2]));
assert.ok(Math.abs(zJih - 4) < 1e-6 && Math.abs(zSever - 6) < 1e-6);

// --- výška střechy ze sklonu (45° nad polovinou šířky 4 m = 2 m) a odhad výšky z podlaží ---
const skl = L.model3d({ building: 'house', 'building:levels': '2', 'roof:angle': '45', 'roof:shape': 'gabled' }, dum);
assert.ok(Math.abs(Math.max(...skl.plochy.flatMap(f => f.body).map(b => b[2])) - 8) < 1e-6);   // 2×3 + 2
assert.ok(skl.poznamky.some(t => /odhad/.test(t)));
// jehlan a kopule: vrchol nad středem půdorysu, výška = height
const jeh = L.model3d({ building: 'yes', height: '10', 'roof:height': '4', 'roof:shape': 'pyramidal' }, dum);
assert.ok(jeh.plochy.flatMap(f => f.body).some(b => Math.abs(b[0] - 5) < 1e-6 && Math.abs(b[1] - 2) < 1e-6 && Math.abs(b[2] - 10) < 1e-6));
const kop = L.model3d({ building: 'yes', height: '10', 'roof:height': '4', 'roof:shape': 'dome' }, dum);
assert.ok(Math.abs(Math.max(...kop.plochy.flatMap(f => f.body).map(b => b[2])) - 10) < 1e-6);
// spodní hrana: stěny začínají v min_height
const most = L.model3d({ 'building:part': 'yes', height: '9', min_height: '4' }, dum);
assert.ok(Math.min(...most.plochy.flatMap(f => f.body).map(b => b[2])) === 4);

// --- SVG: polygony, žádný neošetřený text z dat ---
const s3 = L.svg3d([podel], 30);
// 8 ploch (4 stěny, 2 strany střechy, 2 štíty) – odvrácené se nekreslí, takže jich je méně
assert.ok(s3.startsWith('<svg') && (s3.match(/<polygon/g) || []).length >= 4 && (s3.match(/<polygon/g) || []).length < 8);

// --- v1.3.1 perspektiva: stěny vždy proti směru hodin (vnější normála míří ven z budovy) ---
for (const p of [dum, dum.slice().reverse()]) {
  const m = L.model3d({ building: 'yes', height: '6' }, p);
  for (const f of m.plochy.filter(x => x.druh === 'stena')) {
    const [a, b] = f.body, n = [b[1] - a[1], -(b[0] - a[0])], mid = [(a[0] + b[0]) / 2 - 5, (a[1] + b[1]) / 2 - 2];
    assert.ok(n[0] * mid[0] + n[1] * mid[1] > 0, 'stěna musí mířit ven i u půdorysu po směru hodin');
  }
}
// kvádr: vidět jsou 2 stěny + střecha (zadní stěny vynechané), střecha až po stěnách,
// svislé hrany stěn zůstávají svislé, vodorovné hrany se sbíhají (= skutečná perspektiva)
const polygony = s => [...s.matchAll(/points="([^"]+)" fill="([^"]+)"/g)].map(m => ({ b: m[1].split(' ').map(t => t.split(',').map(Number)), fill: m[2] }));
const kv = polygony(L.svg3d([L.model3d({ building: 'yes', height: '6', 'roof:colour': '#0000ff' }, dum)], 30));
assert.strictEqual(kv.length, 3);
assert.ok(/^rgb\(0,0,\d+\)$/.test(kv[2].fill));                                  // střecha poslední
for (const w of kv.slice(0, 2)) assert.ok(Math.abs(w.b[0][0] - w.b[3][0]) < 0.11 && Math.abs(w.b[1][0] - w.b[2][0]) < 0.11);
const r = kv[2].b, e1 = [r[1][0] - r[0][0], r[1][1] - r[0][1]], e2 = [r[2][0] - r[3][0], r[2][1] - r[3][1]];
assert.ok(Math.abs(e1[0] * e2[1] - e1[1] * e2[0]) > 1, 'protější hrany střechy nemají být rovnoběžné');
// dvě budovy: pohled od jihu (azimut 0) → nejdřív celá severní (vzdálená), pak celá jižní
const posun = (p, dy) => p.map(([x, y]) => [x, y + dy]);
const dvo = polygony(L.svg3d([L.model3d({ building: 'yes', height: '6', 'building:colour': '#ff0000', 'roof:colour': '#ff0000' }, posun(dum, 30)),
  L.model3d({ building: 'yes', height: '6', 'building:colour': '#00ff00', 'roof:colour': '#00ff00' }, posun(dum, -30))], 0));
const jeCervena = f => /^rgb\(\d+,0,0\)$/.test(f.fill);
assert.ok(dvo.length > 2 && dvo.findIndex(f => !jeCervena(f)) > dvo.map(jeCervena).lastIndexOf(true));
// kopule na tamburu: i když má střed o kus dál od kamery, kreslí se až po tamburu (jinak ji zakryje jeho střecha)
const tambur = [[0, 0], [8, 0], [8, 8], [0, 8]];
const kk = polygony(L.svg3d([L.model3d({ 'building:part': 'yes', height: '10', 'building:colour': '#ff0000', 'roof:colour': '#ff0000' }, tambur),
  L.model3d({ 'building:part': 'yes', height: '14', min_height: '10', 'roof:height': '4', 'roof:shape': 'dome', 'building:colour': '#00ff00', 'roof:colour': '#00ff00' }, [[1, 2], [7, 2], [7, 7.5], [1, 7.5]])], 0));
assert.ok(kk.findIndex(f => !jeCervena(f)) > kk.map(jeCervena).lastIndexOf(true), 'kopule se musí kreslit po tamburu');
assert.ok(!L.svg3d([L.model3d({ building: 'yes', height: '5', 'building:colour': '"><script>' }, dum)], 0).includes('<script>'));
assert.ok(L.svg3d([], 0).includes('<svg'));                                       // prázdný model nespadne

// --- otočení pultové střechy o 180° ---
assert.deepStrictEqual(L.otocO180({ 'roof:direction': '90' }), { 'roof:direction': '270' });
assert.deepStrictEqual(L.otocO180({ 'roof:direction': 'NW' }), { 'roof:direction': '135' });
assert.deepStrictEqual(L.otocO180({}), {});
assert.ok(L.ORIENTOVATELNE.includes('gabled') && !L.ORIENTOVATELNE.includes('skillion'));

// --- v1.4 rovný skelet: střecha nad půdorysem do L, T, U… (ne nad obdélníkem kolem něj) ---
const plocha2d = b => Math.abs(b.reduce((s, p, i) => { const q = b[(i + 1) % b.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const vzdalPrimky = (p, a, b) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
const kontrolaSkeletu = (pud, plochaOcek, hmaxOcek, popis) => {
  const s = L.rovnySkelet(pud);
  assert.ok(s, popis + ': skelet se nespočítal');
  assert.strictEqual(s.plochy.length, pud.length, popis + ': jedna plocha střechy na každou zeď');
  const soucet = s.plochy.reduce((a, f) => a + plocha2d(f.body), 0);
  assert.ok(Math.abs(soucet - plochaOcek) < 0.01 * plochaOcek, popis + ': plochy střechy musí pokrýt půdorys (' + soucet.toFixed(2) + ')');
  if (hmaxOcek !== null) assert.ok(Math.abs(s.hmax - hmaxOcek) < 1e-6, popis + ': hmax ' + s.hmax);
  // každá plocha je rovina se sklonem 45° od své zdi: výška bodu = vzdálenost od přímky zdi
  for (const f of s.plochy) for (const p of f.body) assert.ok(Math.abs(p[2] - vzdalPrimky(p, f.a, f.b)) < 1e-6, popis + ': bod mimo rovinu své zdi');
  return s;
};
const obd = kontrolaSkeletu([[0, 0], [10, 0], [10, 4], [0, 4]], 40, 2, 'obdélník');
assert.strictEqual(obd.plochy.filter(f => f.body.length === 3).length, 2);         // dvě valbové trojúhelníky
const tvarL = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
kontrolaSkeletu(tvarL, 64, 2, 'L');
kontrolaSkeletu([[0, 0], [12, 0], [12, 4], [8, 4], [8, 10], [4, 10], [4, 4], [0, 4]], 72, 2, 'T');
kontrolaSkeletu([[0, 0], [12, 0], [12, 10], [8, 10], [8, 4], [4, 4], [4, 10], [0, 10]], 96, 2, 'U');
kontrolaSkeletu([[0, 0], [6, 0], [9, 3], [12, 0], [14, 6], [7, 9], [0, 6]], plocha2d([[0, 0], [6, 0], [9, 3], [12, 0], [14, 6], [7, 9], [0, 6]]), null, 'nepravidelný');
// skutečné křídlo rezidence na Svatém Kopečku (w357664860, 19 uzlů, místy skoro v přímce)
const kridlo = [[-19.8, 8.59], [-6.77, -19.26], [-5.43, -22.14], [-4.42, -23.88], [2.58, -20.45], [4.0, -19.76], [2.27, -16.28], [1.8, -15.33], [1.03, -13.79], [-4.53, -2.61], [0.72, -0.15], [-2.5, 6.2], [24.01, 18.59], [21.84, 23.64], [10.85, 18.41], [8.99, 22.34], [-3.53, 16.59], [-3.52, 16.39], [-7.81, 14.33]].reverse();
const sk = L.rovnySkelet(kridlo);
assert.ok(sk && Math.abs(sk.plochy.reduce((a, f) => a + plocha2d(f.body), 0) - plocha2d(kridlo)) < 0.001 * plocha2d(kridlo), 'křídlo rezidence: plocha');
// Vzorkování po 20 cm: každý bod uvnitř budovy musí ležet právě v jedné ploše střechy
// (odhalí díry i překřížené plochy, které součet ploch neprozradí).
const uvnitr = (p, b) => { let c = false; for (let i = 0, j = b.length - 1; i < b.length; j = i++) if ((b[i][1] > p[1]) !== (b[j][1] > p[1]) && p[0] < (b[j][0] - b[i][0]) * (p[1] - b[i][1]) / (b[j][1] - b[i][1]) + b[i][0]) c = !c; return c; };
const pokryti = (s, pud) => { let spatne = 0, vse = 0;
  for (let x = -30; x < 30; x += 0.2) for (let y = -30; y < 30; y += 0.2) { const p = [x + 0.013, y + 0.007]; if (!uvnitr(p, pud)) continue; vse++; if (s.plochy.filter(f => !f.stit && uvnitr(p, f.body)).length !== 1) spatne++; }
  return spatne / vse; };
assert.ok(pokryti(sk, kridlo) < 0.0002, 'křídlo rezidence: díry nebo překryvy ve střeše (' + (100 * pokryti(sk, kridlo)).toFixed(2) + ' %)');
assert.ok(pokryti(L.rovnySkelet([[0, 0], [12, 0], [12, 10], [8, 10], [8, 4], [4, 4], [4, 10], [0, 10]]), [[0, 0], [12, 0], [12, 10], [8, 10], [8, 4], [4, 4], [4, 10], [0, 10]]) < 0.0002, 'U: pokrytí');
// sedlo: konce ramen L se z valby změní na svislé štíty
const sedloL = L.rovnySkelet(tvarL, { stity: true });
assert.strictEqual(sedloL.plochy.filter(f => f.stit).length, 2);
// model3d: L s valbou i sedlem už bez poznámky „nad obdélníkem“, střecha přesně nad půdorysem
for (const tvar of ['hipped', 'gabled']) {
  const mL = L.model3d({ building: 'yes', height: '9', 'roof:height': '3', 'roof:shape': tvar }, tvarL);
  assert.ok(!mL.poznamky.some(t => /obdélník/.test(t)), tvar + ': ' + mL.poznamky.join(';'));
  const strechy = mL.plochy.filter(f => f.druh === 'strecha');
  assert.ok(Math.abs(strechy.reduce((a, f) => a + plocha2d(f.body), 0) - 64) < 0.5, tvar + ': plocha střechy');
  assert.ok(Math.abs(Math.max(...mL.plochy.flatMap(f => f.body).map(b => b[2])) - 9) < 1e-6, tvar + ': výška');
  assert.ok(Math.min(...strechy.flatMap(f => f.body).map(b => b[2])) >= 6 - 1e-6, tvar + ': okap ve 6 m');
  if (tvar === 'gabled') assert.strictEqual(mL.plochy.filter(f => f.druh === 'stit').length, 2);
}
// valba z půdorysu po směru hodin dopadne stejně (model3d si ho otočí)
assert.strictEqual(L.model3d({ building: 'yes', height: '9', 'roof:height': '3', 'roof:shape': 'hipped' }, tvarL.slice().reverse()).plochy.filter(f => f.druh === 'strecha').length, 6);
assert.ok(L.svg3d([L.model3d({ building: 'yes', height: '9', 'roof:height': '3', 'roof:shape': 'gabled' }, tvarL)], 30).includes('<polygon'));

console.log('OK – všechny testy prošly');
