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
assert.ok(s3.startsWith('<svg') && (s3.match(/<polygon/g) || []).length >= 8);
assert.ok(!L.svg3d([L.model3d({ building: 'yes', height: '5', 'building:colour': '"><script>' }, dum)], 0).includes('<script>'));
assert.ok(L.svg3d([], 0).includes('<svg'));                                       // prázdný model nespadne

// --- otočení pultové střechy o 180° ---
assert.deepStrictEqual(L.otocO180({ 'roof:direction': '90' }), { 'roof:direction': '270' });
assert.deepStrictEqual(L.otocO180({ 'roof:direction': 'NW' }), { 'roof:direction': '135' });
assert.deepStrictEqual(L.otocO180({}), {});
assert.ok(L.ORIENTOVATELNE.includes('gabled') && !L.ORIENTOVATELNE.includes('skillion'));

console.log('OK – všechny testy prošly');
