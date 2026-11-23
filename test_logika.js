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

console.log('OK – všechny testy prošly');
