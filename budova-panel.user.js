// ==UserScript==
// @name         iD – panel Budova (střechy, výšky, podlaží)
// @namespace    osm-edit-budovy
// @version      1.4.0
// @author       MartinSimco
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/MartinSimco/iD-budova-panel
// @supportURL   https://github.com/MartinSimco/iD-budova-panel/issues
// (updateURL/downloadURL: Tampermonkey odtud sám stahuje nové verze)
// @updateURL    https://raw.githubusercontent.com/MartinSimco/iD-budova-panel/main/budova-panel.user.js
// @downloadURL  https://raw.githubusercontent.com/MartinSimco/iD-budova-panel/main/budova-panel.user.js
// @description  Vizuální panel pro 3D atributy budov v editoru iD na openstreetmap.org: živý 3D náhled, boční řez s kótami, předvolby typů budov (panelák, rodinný dům, hala …), tvar a sklon střechy, podlaží, dopočet výšky, barvy, materiály, bez oken, průjezdy a upozornění.
// @match        https://www.openstreetmap.org/id*
// @run-at       document-idle
// @grant        GM_addStyle
// (GM_addStyle: osm.org má přísnou CSP – vlastní <style> ani style="…" nepovolí;
//  Tampermonkey styly vloží mimo CSP. Ověřeno živě 2026-11-23.)
// ==/UserScript==

/*
 * Jak to celé funguje (stručně):
 *  1) ČISTÁ LOGIKA – práce se značkami jako s obyčejným objektem {klíč: hodnota}.
 *     Nesahá na stránku, takže ji jde testovat v Node (test_logika.js).
 *  2) MOST K iD – iD nemá rozhraní pro pluginy a Tampermonkey nás na osm.org spouští
 *     pozdě (vnitřní "context" iD už nejde zachytit, ověřeno 2026-11-23). Proto čteme
 *     a zapisujeme značky přes textové pole v sekci "Značky" – úplně stejně, jako by je
 *     uživatel napsal ručně. Validaci, historii (Zpět) i ukládání pak řeší iD samo.
 *  3) PANEL – vykreslí boční řez a ovládací prvky; každá akce = jeden zápis = jeden krok Zpět.
 */
(function () {
  'use strict';

  /* ======================================================================
   * 1) ČISTÁ LOGIKA
   * ==================================================================== */

  // Tvary střech (hodnoty roof:shape podle OSM wiki) s českými názvy pro tlačítka.
  const ROOF_SHAPES = [
    { value: 'flat', label: 'Plochá' },
    { value: 'gabled', label: 'Sedlová' },
    { value: 'hipped', label: 'Valbová' },
    { value: 'half-hipped', label: 'Polovalbová' },
    { value: 'pyramidal', label: 'Jehlanová' },
    { value: 'skillion', label: 'Pultová' },
    { value: 'gambrel', label: 'Dvouplášťová' },
    { value: 'mansard', label: 'Mansardová' },
    { value: 'dome', label: 'Kopule' },
    { value: 'onion', label: 'Cibule' },
    { value: 'round', label: 'Válcová' },
    { value: 'cone', label: 'Kužel' }
  ];

  // Materiály fasády (building:material) – hodnoty dle OSM wiki.
  const MATERIALS_BUILDING = [
    { value: 'plaster', label: 'omítka' },
    { value: 'brick', label: 'cihla' },
    { value: 'stone', label: 'kámen' },
    { value: 'concrete', label: 'beton' },
    { value: 'wood', label: 'dřevo' },
    { value: 'timber_framing', label: 'hrázděné zdivo' },
    { value: 'glass', label: 'sklo' },
    { value: 'metal', label: 'kov' }
  ];

  // Materiály střechy (roof:material).
  const MATERIALS_ROOF = [
    { value: 'roof_tiles', label: 'pálené/betonové tašky' },
    { value: 'slate', label: 'břidlice' },
    { value: 'metal', label: 'plech' },
    { value: 'copper', label: 'měď' },
    { value: 'concrete', label: 'beton' },
    { value: 'tar_paper', label: 'lepenka' },
    { value: 'wood', label: 'dřevo / šindel' },
    { value: 'glass', label: 'sklo' },
    { value: 'thatch', label: 'došky' },
    { value: 'grass', label: 'zelená střecha' }
  ];

  // Barvy (building:colour, roof:colour). value = co se zapíše do OSM,
  // hex = jak vzorek vypadá na obrazovce (u názvů, které nejsou CSS barvou, např. "sand").
  const COLOURS = [
    { value: 'white', label: 'bílá', hex: '#ffffff' },
    { value: 'beige', label: 'béžová', hex: '#f5f5dc' },
    { value: 'sand', label: 'písková', hex: '#e8d49a' },
    { value: 'yellow', label: 'žlutá', hex: '#f2d14b' },
    { value: 'orange', label: 'oranžová', hex: '#e8893a' },
    { value: 'red', label: 'červená', hex: '#c0392b' },
    { value: 'brown', label: 'hnědá', hex: '#7b4a2a' },
    { value: 'green', label: 'zelená', hex: '#4f8a4b' },
    { value: 'blue', label: 'modrá', hex: '#3b6fb6' },
    { value: 'grey', label: 'šedá', hex: '#8c8c8c' },
    { value: 'black', label: 'černá', hex: '#222222' }
  ];

  // Text z textového pole iD → objekt značek.
  // Dělíme na PRVNÍM "=", protože hodnota sama "=" obsahovat smí (např. URL).
  function parseTagText(text) {
    const tags = {};
    for (const radek of String(text).split('\n')) {
      const i = radek.indexOf('=');
      if (i < 1) continue;                       // prázdný řádek nebo řádek bez klíče
      const klic = radek.slice(0, i).trim();
      if (!klic) continue;
      tags[klic] = radek.slice(i + 1).trim();
    }
    return tags;
  }

  // Objekt značek → text pro textové pole iD (jeden řádek = jedna značka).
  function serializeTags(tags) {
    return Object.keys(tags).map(k => k + '=' + tags[k]).join('\n');
  }

  // Vrátí NOVÝ objekt značek se změnami. Hodnota undefined nebo '' znamená "klíč smazat".
  // Původní objekt se nemění (snazší ladění, žádné skryté vedlejší efekty).
  function applyChanges(tags, changes) {
    const vysledek = Object.assign({}, tags);
    for (const k of Object.keys(changes)) {
      const v = changes[k];
      if (v === undefined || v === '') delete vysledek[k];
      else vysledek[k] = String(v);
    }
    return vysledek;
  }

  // Číslo z formuláře → hodnota pro OSM (metry, desetinná tečka), nebo null když je neplatné.
  // Přijme "7,5", "7.5", "25 m"; odmítne text, záporná čísla a prázdný vstup.
  function normalizeNumber(input) {
    const s = String(input == null ? '' : input).trim().replace(/\s*m$/i, '').replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(s)) return null;  // jen nezáporné desetinné číslo
    return String(Number(s));                   // "07.50" → "7.5"
  }

  // Pomocník: hodnota značky jako číslo, nebo NaN když chybí/není číslo.
  const cislo = v => (v === undefined ? NaN : Number(String(v).replace(',', '.')));

  // Upozornění na podezřelé kombinace. Jen informují – panel nic neopravuje sám.
  function checkWarnings(tags) {
    const w = [];
    const h = cislo(tags.height);
    const rh = cislo(tags['roof:height']);
    const minh = cislo(tags.min_height);
    if (!isNaN(h) && !isNaN(rh) && rh >= h) {
      w.push({ key: 'roof:height', text: 'Výška střechy (' + rh + ' m) je stejná nebo větší než celková výška budovy (' + h + ' m). Celková výška (height) zahrnuje i střechu.' });
    }
    if (!isNaN(h) && !isNaN(minh) && minh >= h) {
      w.push({ key: 'min_height', text: 'Spodní hrana (min_height ' + minh + ' m) je stejná nebo vyšší než horní hrana (height ' + h + ' m).' });
    }
    const sakralni = ['church', 'cathedral', 'chapel', 'basilica', 'tower'];
    if (tags['building:flats'] !== undefined && sakralni.includes(tags.building)) {
      w.push({ key: 'building:flats', text: 'Počet bytů u typu „' + tags.building + '“ – pravděpodobně pozůstatek importu z RÚIAN, zkontroluj.' });
    }
    if (tags['building:levels'] === '1' && !isNaN(h) && h >= 15) {
      w.push({ key: 'building:levels', text: '1 podlaží při výšce ' + h + ' m – možná pozůstatek importu z RÚIAN (u kostelů s jednou vysokou lodí to ale může sedět).' });
    } else {
      // Výška jednoho patra z dat (height − střecha) / podlaží. Běžné patro má 2,5–4 m,
      // haly a obchody víc; mimo 2,2–6 m jde skoro jistě o překlep nebo starý import.
      const patro = vyskaPatra(tags);
      if (patro !== null && (patro < 2.2 || patro > 6)) {
        w.push({ key: 'building:levels', text: 'Vychází ' + zaokrouhli(patro) + ' m na jedno podlaží – zkontroluj height a building:levels (běžné patro má 2,5–4 m).' });
      }
    }
    // Desetinná čárka v datech: OSM vyžaduje tečku, renderery "7,5" nepřečtou
    // (panel by ji sám kreslil jako 7.5 a chyba by nebyla vidět – proto upozornit).
    for (const klic of ['height', 'roof:height', 'min_height', 'building:levels', 'roof:levels', 'building:min_level']) {
      if (tags[klic] !== undefined && tags[klic].includes(',')) {
        w.push({ key: klic, text: 'Hodnota ' + klic + '=' + tags[klic] + ' má desetinnou čárku – OSM používá tečku. Zadej ji v panelu znovu.' });
      }
    }
    return w;
  }

  /* ---------------- v1.2: předvolby typů budov a další 3D značky ---------------- */

  // Číslo → text pro OSM s nejvýš 1 desetinným místem ("22.4", "10", ne "22.400000001").
  const zaokrouhli = n => String(Math.round(n * 10) / 10);

  // Typické budovy. Hodnoty jsou ODHAD pro „běžnou“ českou stavbu – panel je doplní jen
  // tam, kde v datech nic není, a uživatel je má ověřit na ortofotu. Úpravy a nové typy
  // se dělají přímo tady (každý řádek = jedno tlačítko v panelu).
  //   building   – na co změnit building=yes (jiný typ se nepřepisuje)
  //   znacky     – značky, které se doplní, když chybí
  //   patro      – typická výška jednoho podlaží (m) pro dopočet height
  //   roofHeight – typická výška šikmé střechy (m); u ploché se nezadává
  const PREDVOLBY = [
    { id: 'panelak', label: 'Panelák', building: 'apartments', znacky: { 'roof:shape': 'flat' }, patro: 2.8 },
    { id: 'cihlovy', label: 'Cihlový bytový dům', building: 'apartments', znacky: { 'roof:shape': 'hipped', 'roof:material': 'roof_tiles', 'roof:colour': '#b5482f' }, patro: 3.3, roofHeight: 4 },
    { id: 'rodinny', label: 'Rodinný dům', building: 'house', znacky: { 'roof:shape': 'gabled', 'roof:material': 'roof_tiles', 'roof:colour': '#b5482f' }, patro: 3, roofHeight: 4 },
    { id: 'radovy', label: 'Řadový dům', building: 'terrace', znacky: { 'roof:shape': 'gabled', 'roof:material': 'roof_tiles', 'roof:colour': '#b5482f' }, patro: 3, roofHeight: 3.5 },
    { id: 'obchod', label: 'Obchodní centrum', building: 'retail', znacky: { 'roof:shape': 'flat' }, patro: 6 },
    { id: 'hala', label: 'Hala / sklad', building: 'industrial', znacky: { 'roof:shape': 'flat', 'roof:material': 'metal' }, patro: 7 },
    { id: 'garaze', label: 'Garáže', building: 'garages', znacky: { 'roof:shape': 'flat', window: 'no' }, patro: 2.5 }
  ];

  // Je hodnota „prázdná“ = může ji předvolba doplnit? '*' NENÍ prázdná: znamená, že ji
  // aspoň část vybraných budov má (hromadný výběr) → nesahat.
  const prazdne = v => v === undefined || v === '';

  // Výška střechy pro výpočty: zadaná roof:height, u ploché (nebo nezadané) střechy 0,
  // u šikmé bez roof:height null = nevíme (výpočet by byl nepravdivý).
  function vyskaStrechy(tags) {
    const rh = cislo(tags['roof:height']);
    if (!isNaN(rh)) return rh;
    const tvar = tags['roof:shape'];
    return !tvar || tvar === 'flat' ? 0 : null;
  }

  // height = podlaží × výška patra + střecha. Vrací text k zápisu, nebo null, když
  // podlaží nejsou celé číslo > 0 nebo neznáme výšku šikmé střechy.
  function vypoctiVysku(tags, patro) {
    if (!/^\d+$/.test(tags['building:levels'] || '') || Number(tags['building:levels']) < 1) return null;
    const rh = vyskaStrechy(tags);
    if (rh === null || !(patro > 0)) return null;
    return zaokrouhli(Number(tags['building:levels']) * patro + rh);
  }

  // Skutečná výška jednoho patra podle dat, nebo null (chybí údaje / 0 podlaží).
  function vyskaPatra(tags) {
    const h = cislo(tags.height), lv = cislo(tags['building:levels']), rh = vyskaStrechy(tags);
    if (isNaN(h) || !(lv > 0) || rh === null) return null;
    return (h - rh) / lv;
  }

  // Změny, které udělá předvolba `id`. hromadne = vybráno víc budov → výšku nepočítat
  // (každá má jiná podlaží a do všech by se zapsala stejná).
  function predvolbaZmeny(tags, id, hromadne) {
    const p = PREDVOLBY.find(x => x.id === id);
    if (!p) return {};
    const zmeny = {};
    if (tags.building === 'yes' && p.building) zmeny.building = p.building;      // jen obecné "yes"
    for (const [klic, hodnota] of Object.entries(p.znacky)) {
      if (prazdne(tags[klic])) zmeny[klic] = hodnota;
    }
    const tvar = tags['roof:shape'] || zmeny['roof:shape'];
    if (p.roofHeight && tvar && tvar !== 'flat' && prazdne(tags['roof:height'])) zmeny['roof:height'] = String(p.roofHeight);
    if (!hromadne && prazdne(tags.height)) {
      const h = vypoctiVysku(Object.assign({}, tags, zmeny), p.patro);
      if (h !== null) zmeny.height = h;
    }
    return zmeny;
  }

  // Který typ budovy to nejspíš je (jen ZVÝRAZNĚNÍ tlačítka – nic se nezapisuje).
  function navrhTypu(tags) {
    const b = tags.building, lv = cislo(tags['building:levels']);
    if (b === 'apartments') return lv >= 5 ? 'panelak' : (lv > 0 ? 'cihlovy' : null);
    if (b === 'house' || b === 'detached' || b === 'semidetached_house') return 'rodinny';
    if (b === 'terrace') return 'radovy';
    if (b === 'retail' || b === 'supermarket' || b === 'commercial') return 'obchod';
    if (b === 'industrial' || b === 'warehouse') return 'hala';
    if (b === 'garages' || b === 'garage') return 'garaze';
    return null;
  }

  // Směr spádu pultové střechy (roof:direction) – kam se střecha „dívá“ (ve směru stékání vody).
  const SMERY = [
    { label: 'S', deg: 0 }, { label: 'SV', deg: 45 }, { label: 'V', deg: 90 }, { label: 'JV', deg: 135 },
    { label: 'J', deg: 180 }, { label: 'JZ', deg: 225 }, { label: 'Z', deg: 270 }, { label: 'SZ', deg: 315 }
  ];
  // OSM povoluje stupně i zkratky světových stran (anglicky, 16 směrů) → stupně, jinak null.
  function smerNaStupne(v) {
    const ANGL = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const i = ANGL.indexOf(String(v).toUpperCase());
    if (i >= 0) return i * 22.5;
    const n = Number(v);
    return v !== '' && !isNaN(n) && n >= 0 && n <= 360 ? n : null;
  }

  // Budova bez oken: běžnější je window=no, méně často windows=no – uznáváme obojí.
  const bezOken = tags => tags.window === 'no' || tags.windows === 'no';
  // Zapnout → window=no; vypnout → smazat obě varianty "no" (jiné hodnoty window nechat).
  function zmenyOkna(tags, zapnout) {
    if (zapnout) return { window: 'no' };
    const z = {};
    if (tags.window === 'no') z.window = undefined;
    if (tags.windows === 'no') z.windows = undefined;
    return z;
  }

  // Část budovy nad průjezdem: začíná nad průjezdem (typicky 4 m, tj. nad přízemím).
  function zmenyPrujezd(tags) {
    const z = {};
    if (prazdne(tags.min_height)) z.min_height = '4';
    if (prazdne(tags['building:min_level'])) z['building:min_level'] = '1';
    return z;
  }

  /* ---------------- v1.3: živý 3D náhled a otočení střechy ---------------- */

  // Tvary, u kterých má smysl hřeben „podél / napříč“ (roof:orientation).
  const ORIENTOVATELNE = ['gabled', 'hipped', 'half-hipped', 'gambrel', 'mansard', 'round'];

  // Pultová střecha otočená o 180° (spád na opačnou stranu). Bez směru nevíme, odkud otáčet.
  function otocO180(tags) {
    const deg = smerNaStupne(tags['roof:direction'] || '');
    return deg === null ? {} : { 'roof:direction': zaokrouhli((deg + 180) % 360) };
  }

  // Kolik metrů měří jeden pixel mapy (Web Mercator, dlaždice 256 px) při zoomu z
  // a zeměpisné šířce lat. Na rovníku při z=0 je to obvod Země / 256 ≈ 156 543 m.
  const mNaPx = (z, lat) => 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);

  // Půdorys z atributu "d" SVG cesty, kterou iD kreslí v mapě: dvojice čísel = body v pixelech.
  // Převedeme na metry; osa y v obrazovce míří dolů, my chceme y = sever (nahoru) → znaménko.
  // Uzavřenou cestu (poslední bod = první) zkrátíme o opakovaný bod.
  function pudorysZCesty(d, m) {
    const c = String(d).match(/-?\d+(\.\d+)?(e-?\d+)?/gi) || [];
    const pts = [];
    for (let i = 0; i + 1 < c.length; i += 2) {
      const p = [Number(c[i]) * m, -Number(c[i + 1]) * m || 0];      // "|| 0": z -0 udělat 0
      const prev = pts[pts.length - 1];
      if (!prev || Math.hypot(p[0] - prev[0], p[1] - prev[1]) > 1e-9) pts.push(p);
    }
    if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop();
    return pts;
  }

  // Konvexní obal (Andrewův algoritmus) – nejmenší „gumička“ kolem bodů.
  function konvexniObal(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const kriz = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const dol = [], hor = [];
    for (const q of p) { while (dol.length >= 2 && kriz(dol[dol.length - 2], dol[dol.length - 1], q) <= 0) dol.pop(); dol.push(q); }
    for (const q of p.reverse()) { while (hor.length >= 2 && kriz(hor[hor.length - 2], hor[hor.length - 1], q) <= 0) hor.pop(); hor.push(q); }
    return dol.slice(0, -1).concat(hor.slice(0, -1));
  }

  // Nejmenší obdélník kolem půdorysu: jedna jeho strana vždy leží na hraně konvexního obalu,
  // stačí tedy vyzkoušet všechny hrany obalu. Vrací střed, jednotkové osy (u = delší strana)
  // a rozměry. Podle něj se určuje „delší strana“ budovy pro roof:orientation.
  function obdelnik(pts) {
    const obal = konvexniObal(pts);
    let nej = null;
    for (let i = 0; i < obal.length; i++) {
      const a = obal[i], b = obal[(i + 1) % obal.length];
      const del = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (del < 1e-9) continue;
      const ux = (b[0] - a[0]) / del, uy = (b[1] - a[1]) / del, vx = -uy, vy = ux;
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const q of obal) {
        const u = q[0] * ux + q[1] * uy, v = q[0] * vx + q[1] * vy;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const plocha = (u1 - u0) * (v1 - v0);
      if (!nej || plocha < nej.plocha - 1e-9) nej = { plocha, ux, uy, vx, vy, u0, u1, v0, v1 };
    }
    if (!nej) return { cx: 0, cy: 0, ux: 1, uy: 0, vx: 0, vy: 1, delka: 0, sirka: 0 };
    let { ux, uy, vx, vy } = nej, du = nej.u1 - nej.u0, dv = nej.v1 - nej.v0;
    const su = (nej.u0 + nej.u1) / 2, sv = (nej.v0 + nej.v1) / 2;
    const cx = su * ux + sv * vx, cy = su * uy + sv * vy;
    if (dv > du) { [ux, uy, vx, vy] = [vx, vy, -ux, -uy]; [du, dv] = [dv, du]; }   // u = delší osa
    return { cx, cy, ux, uy, vx, vy, delka: du, sirka: dv };
  }

  // Těžiště polygonu (plošně vážené); u degenerovaného polygonu průměr bodů.
  function teziste(pts) {
    let A = 0, x = 0, y = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length], c = x0 * y1 - x1 * y0;
      A += c; x += (x0 + x1) * c; y += (y0 + y1) * c;
    }
    if (Math.abs(A) < 1e-9) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    return [x / (3 * A), y / (3 * A)];
  }

  // ROVNÝ SKELET (straight skeleton) – algoritmus Felkel & Obdržálek (1998), přepsaný podle
  // knihovny polyskel. Představa: všechny obvodové zdi se naráz posouvají dovnitř stejnou
  // rychlostí. Kde se dvě posouvané zdi potkají, vznikne nároží/úžlabí; kde zmizí celá zeď,
  // vznikne hřeben. Výška bodu střechy = o kolik se zeď do té doby posunula (sklon 45°,
  // model3d ho pak přeškáluje na roof:height). Tak to dělají i F4map, OSM2World a Streets GL –
  // valba pak sedí nad jakýmkoliv půdorysem (L, T, U, mnohoúhelník), ne jen nad obdélníkem.
  //
  // Vstup: body půdorysu [[x, y]…] (libovolná orientace). Volba stity: true = sedlová střecha –
  // valbové trojúhelníky na koncích ramen se překlopí na svislé štíty (jako Streets GL).
  // Výstup: { plochy: [{ a, b, body: [[x, y, h]…], stit }], hmax } – jedna plocha na každou zeď
  // a→b; nebo null, když výpočet nevyjde (pak model3d použije starou střechu nad obdélníkem).
  function rovnySkelet(vstup, volby) {
    // Degenerované půdorysy (víc událostí přesně v jednom bodě, přesně rovnoběžné zdi) algoritmus
    // občas nezvládne. Pomůže posunout body o pár milimetrů („perturbace“) a zkusit to znovu –
    // ve výsledku to není vidět. Posun je pevný (ne náhodný), aby náhled vycházel pokaždé stejně.
    // ponytail: nanejvýš 3 pokusy; co nevyjde ani pak, kreslí model3d starou střechou nad obdélníkem.
    for (let pokus = 0; pokus < 4; pokus++) {
      const k = [0, 0.002, 0.005, 0.011][pokus];
      const s = rovnySkeletJednou(vstup.map((p, i) => [p[0] + k * Math.sin(i * 1.7), p[1] + k * Math.cos(i * 2.3)]), volby);
      if (s) return s;
    }
    return null;
  }
  function rovnySkeletJednou(vstup, volby) {
    const EPS = 1e-9;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], add = (a, b) => [a[0] + b[0], a[1] + b[1]];
    const mul = (a, k) => [a[0] * k, a[1] * k], dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
    const norm = v => { const l = Math.hypot(v[0], v[1]); return l < EPS ? [0, 0] : [v[0] / l, v[1] / l]; };
    const stejne = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7;

    // 1) Úklid: pryč opakované body a body skoro v přímce (osa úhlu 180° by byla neurčitá).
    let q = vstup.map(p => [p[0], p[1]]);
    for (let zmena = true; zmena && q.length > 3;) {
      zmena = false;
      for (let i = 0; i < q.length && q.length > 3; i++) {
        const a = q[(i - 1 + q.length) % q.length], p = q[i], b = q[(i + 1) % q.length];
        const u = norm(sub(p, a)), w = norm(sub(b, p));
        if (Math.hypot(p[0] - a[0], p[1] - a[1]) < 1e-6 || (Math.abs(cross(u, w)) < 0.01 && dot(u, w) > 0)) { q.splice(i, 1); zmena = true; i--; }
      }
    }
    if (q.length < 3) return null;
    // polyskel počítá s obvodem po směru hodinových ručiček (vnitřek vpravo od směru hrany)
    if (q.reduce((s, p, i) => { const r = q[(i + 1) % q.length]; return s + p[0] * r[1] - r[0] * p[1]; }, 0) > 0) q.reverse();
    const n = q.length;
    const hrany = q.map((p, i) => { const b = q[(i + 1) % n]; return { id: i, a: p, b, v: norm(sub(b, p)) }; });
    const vzdal = (h, p) => Math.abs(cross(h.v, sub(p, h.a)));              // vzdálenost od přímky zdi
    // průsečík přímek p + t·u a r + s·w; paprsek = jen t ≥ 0 (resp. s ≥ 0)
    const prusecik = (p, u, r, w, paprsekA, paprsekB) => {
      const d = cross(u, w); if (Math.abs(d) < EPS) return null;
      const rp = sub(r, p), t = cross(rp, w) / d, s = cross(rp, u) / d;
      if ((paprsekA && t < -EPS) || (paprsekB && s < -EPS)) return null;
      return [p[0] + t * u[0], p[1] + t * u[1]];
    };

    // 2) „Živý obvod“ (LAV = list of active vertices): vrchol má bod, zeď vlevo (končí v něm),
    //    zeď vpravo (začíná v něm) a osu úhlu, po které se při posouvání zdí pohybuje.
    const vrchol = (bod, hL, hP, smery) => {
      const tvurci = [mul(hL.v, -1), hP.v], sm = smery || tvurci;
      const reflex = cross(sm[0], sm[1]) < 0;                                  // vnitřní úhel > 180°
      return { bod, hL, hP, reflex, osa: mul(add(tvurci[0], tvurci[1]), reflex ? -1 : 1), platny: true, prev: null, next: null, lav: null };
    };
    const lavy = [];
    const lavZRetezce = start => { const lav = { head: start, len: 0 }; let v = start; do { v.lav = lav; lav.len++; v = v.next; } while (v !== start && lav.len < 10000); return lav; };
    const vs = q.map((p, i) => vrchol(p, hrany[(i - 1 + n) % n], hrany[i]));
    vs.forEach((v, i) => { v.prev = vs[(i - 1 + n) % n]; v.next = vs[(i + 1) % n]; });
    lavy.push(lavZRetezce(vs[0]));
    // původní zdi s osami na obou koncích – pro test, zda bod „rozdělení“ leží před zdí
    const puvodni = vs.map(v => ({ hrana: v.hL, osaL: { p: v.prev.bod, u: v.prev.osa }, osaP: { p: v.bod, u: v.osa } }));

    // 3) Nejbližší událost vrcholu: srážka s osou souseda (edge event), nebo u vrcholu s úhlem
    //    > 180° náraz do protější zdi, který obvod rozdělí na dva (split event).
    const dalsiUdalost = v => {
      const ud = [];
      if (v.reflex) for (const oe of puvodni) {
        if (oe.hrana === v.hL || oe.hrana === v.hP) continue;
        const vlastni = Math.abs(dot(v.hL.v, oe.hrana.v)) < Math.abs(dot(v.hP.v, oe.hrana.v)) ? v.hL : v.hP;
        const i = prusecik(vlastni.a, vlastni.v, oe.hrana.a, oe.hrana.v, false, false);
        if (!i || stejne(i, v.bod)) continue;
        const lin = norm(sub(v.bod, i));
        let ed = oe.hrana.v; if (dot(lin, ed) < 0) ed = mul(ed, -1);
        const bis = add(ed, lin); if (Math.hypot(bis[0], bis[1]) < EPS) continue;
        const b = prusecik(i, bis, v.bod, v.osa, false, true);
        if (!b) continue;
        const xl = cross(norm(oe.osaL.u), norm(sub(b, oe.osaL.p))) > -EPS;
        const xr = cross(norm(oe.osaP.u), norm(sub(b, oe.osaP.p))) < EPS;
        const xe = cross(oe.hrana.v, norm(sub(b, oe.hrana.a))) < EPS;
        if (xl && xr && xe) ud.push({ typ: 'deleni', d: vzdal(oe.hrana, b), bod: b, v, protejsi: oe.hrana });
      }
      const ip = prusecik(v.bod, v.osa, v.prev.bod, v.prev.osa, true, true);
      const inx = prusecik(v.bod, v.osa, v.next.bod, v.next.osa, true, true);
      if (ip) ud.push({ typ: 'hrana', d: vzdal(v.hL, ip), bod: ip, a: v.prev, b: v });
      if (inx) ud.push({ typ: 'hrana', d: vzdal(v.hP, inx), bod: inx, a: v, b: v.next });
      if (!ud.length) return null;
      const vzd = e => Math.hypot(e.bod[0] - v.bod[0], e.bod[1] - v.bod[1]);
      return ud.reduce((m, e) => vzd(e) < vzd(m) ? e : m);
    };

    // Uzly skeletu (body hřebenů a nároží) a pro každý, kterých zdí se týká.
    const uzly = [];
    const pridejUzel = (bod, h, ids) => {
      const u = uzly.find(x => stejne(x.bod, bod));                           // stejný bod z víc událostí
      if (u) ids.forEach(i => u.hrany.add(i)); else uzly.push({ bod: bod.slice(), h, hrany: new Set(ids) });
    };
    const hranaUdalost = e => {
      const lav = e.a.lav;
      if (e.a.prev === e.b.next) {                                             // poslední trojúhelník = vrchol
        lavy.splice(lavy.indexOf(lav), 1);
        const ids = []; let v = lav.head, k = 0;
        do { ids.push(v.hL.id, v.hP.id); v.platny = false; v = v.next; } while (v !== lav.head && ++k < 10000);
        pridejUzel(e.bod, e.d, ids);
        return [];
      }
      const nv = vrchol(e.bod, e.a.hL, e.b.hP, [norm(e.b.osa), norm(e.a.osa)]);
      nv.lav = lav; nv.prev = e.a.prev; nv.next = e.b.next; e.a.prev.next = nv; e.b.next.prev = nv;
      if (lav.head === e.a || lav.head === e.b) lav.head = nv;
      e.a.platny = e.b.platny = false; lav.len--;
      pridejUzel(e.bod, e.d, [e.a.hL.id, e.a.hP.id, e.b.hP.id]);
      const u = dalsiUdalost(nv);
      return u ? [u] : [];
    };
    const deleniUdalost = e => {
      const lav = e.v.lav; let x = null, y = null;
      hledej: for (const l of lavy) {
        let v = l.head, k = 0;
        do {
          if (v.hL === e.protejsi) { x = v; y = v.prev; } else if (v.hP === e.protejsi) { y = v; x = v.next; }
          if (x) {
            const xl = cross(norm(y.osa), norm(sub(e.bod, y.bod))) >= -EPS, xr = cross(norm(x.osa), norm(sub(e.bod, x.bod))) <= EPS;
            if (xl && xr) break hledej;
            x = y = null;
          }
          v = v.next;
        } while (v !== l.head && ++k < 10000);
      }
      if (!x) return [];
      const v1 = vrchol(e.bod, e.v.hL, e.protejsi), v2 = vrchol(e.bod, e.protejsi, e.v.hP);
      v1.prev = e.v.prev; v1.next = x; e.v.prev.next = v1; x.prev = v1;
      v2.prev = y; v2.next = e.v.next; e.v.next.prev = v2; y.next = v2;
      lavy.splice(lavy.indexOf(lav), 1);
      let nove;
      if (lav !== x.lav) { lavy.splice(lavy.indexOf(x.lav), 1); nove = [lavZRetezce(v1)]; }
      else nove = [lavZRetezce(v1), lavZRetezce(v2)];
      const zive = [];
      for (const l of nove) {
        if (l.len > 2) { lavy.push(l); zive.push(l.head); }
        else { let v = l.head, k = 0; do { v.platny = false; v = v.next; } while (v !== l.head && ++k < 10); }   // zbytek = hřeben
      }
      e.v.platny = false;
      pridejUzel(e.bod, e.d, [e.v.hL.id, e.v.hP.id, e.protejsi.id]);
      return zive.map(dalsiUdalost).filter(Boolean);
    };

    // 4) Hlavní smyčka: události v pořadí podle vzdálenosti (= výšky střechy).
    let fronta = vs.map(dalsiUdalost).filter(Boolean), pojistka = 0;
    while (fronta.length && lavy.length && pojistka++ < 20000) {
      fronta.sort((a, b) => a.d - b.d);
      const e = fronta.shift();
      if (e.typ === 'hrana') { if (!e.a.platny || !e.b.platny) continue; fronta.push(...hranaUdalost(e)); }
      else { if (!e.v.platny) continue; fronta.push(...deleniUdalost(e)); }
    }

    // 5) Plochy střechy: plocha zdi a→b = a, b a všechny uzly, kterých se zeď týká.
    //    Pojistka: uzel patří k ploše zdi, jen když jeho výška = vzdálenost od přímky té zdi
    //    (při souběhu víc událostí v jednom bodě se občas přiřadí i zeď, které se netýká).
    //    Druhá pojistka: skutečný uzel skeletu je místo, kde se potkají aspoň tři posouvané zdi,
    //    tedy leží ve stejné výšce nad aspoň třemi přímkami zdí. Uzel, který to nesplňuje, je
    //    numerický artefakt (u téměř rovnoběžných zdí) a do střechy by udělal zářez s dírou.
    const tol = 1e-6 * Math.max(1, ...q.map(p => Math.hypot(p[0], p[1])));
    const platne = uzly.filter(u => hrany.filter(h => Math.abs(vzdal(h, u.bod) - u.h) < tol).length >= 3);
    // Rohy půdorysu jako „uzly“ ve výšce 0 – každý roh patří ke dvěma zdem (té, co v něm končí, a té, co začíná).
    const rohy = q.map((p, i) => ({ bod: p, h: 0 }));
    let plochy = hrany.map((h, i) => ({ h, roh: [rohy[i], rohy[(i + 1) % n]], uzly: platne.filter(u => u.hrany.has(h.id) && Math.abs(vzdal(h, u.bod) - u.h) < tol) }));
    if (!uzly.length || plochy.some(f => !f.uzly.length)) return null;

    // Pořadí bodů po obvodu plochy z TOPOLOGIE: plocha sousedí s jinou plochou podél společné
    // hranice a ta leží na ose úhlu mezi jejich zdmi – tedy na přímce. Body společné oběma plochám
    // proto stačí seřadit podél té přímky a spojit; spolu se samotnou zdí a→b vznikne cyklus,
    // který projdeme. (Pouhé řazení podle polohy podél zdi u nekonvexních ploch selhává.)
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const poradi = f => {
      const vse = [...f.roh, ...f.uzly], soused = new Map(vse.map(u => [u, []]));
      const spoj = (x, y) => { if (x !== y && !soused.get(x).includes(y)) { soused.get(x).push(y); soused.get(y).push(x); } };
      spoj(f.roh[0], f.roh[1]);                                                // samotná zeď
      for (const g of plochy) {
        if (g === f) continue;
        const spolecne = vse.filter(u => g.roh.includes(u) || g.uzly.includes(u));
        if (spolecne.length < 2) continue;
        let p0 = spolecne[0], p1 = spolecne[1], dmax = -1;                     // nejvzdálenější dvojice = směr hranice
        for (const x of spolecne) for (const y of spolecne) if (dist(x.bod, y.bod) > dmax) { dmax = dist(x.bod, y.bod); p0 = x; p1 = y; }
        const sm = norm(sub(p1.bod, p0.bod));
        spolecne.sort((x, y) => dot(sub(x.bod, p0.bod), sm) - dot(sub(y.bod, p0.bod), sm));
        for (let i = 1; i < spolecne.length; i++) spoj(spolecne[i - 1], spolecne[i]);
      }
      if ([...soused.values()].some(s => s.length !== 2)) return null;          // není to čistý cyklus
      const cyklus = [f.roh[0]]; let pred = f.roh[0], ted = f.roh[1];
      while (ted !== f.roh[0] && cyklus.length <= vse.length) { cyklus.push(ted); const dalsi = soused.get(ted).find(x => x !== pred); pred = ted; ted = dalsi; }
      return cyklus.length === vse.length ? cyklus : null;
    };
    plochy.forEach(f => { f.cyklus = poradi(f); });
    // Sedlo: valbový trojúhelník (jediný uzel, sdílený právě třemi zdmi) → uzel posunout na zeď = svislý štít.
    if (volby && volby.stity) for (const f of plochy) {
      const u = f.uzly[0];
      if (f.uzly.length === 1 && u.hrany.size === 3 && plochy.filter(g => g.uzly.includes(u)).length === 3) {
        const t = dot(sub(u.bod, f.h.a), f.h.v); u.bod = [f.h.a[0] + t * f.h.v[0], f.h.a[1] + t * f.h.v[1]]; f.stit = true;
      }
    }
    const hmax = Math.max(...platne.map(u => u.h));
    // Náhradní pořadí, když topologie nedá čistý cyklus: plocha je „monotónní“ ve směru své zdi,
    // v souřadnicích t (poloha podél zdi) a s (výška) ji přímka z nejlevějšího do nejpravějšího bodu
    // dělí na spodní řetěz (se zdí, vzestupně) a horní (sestupně). Spolehlivé jen u konvexních ploch.
    const obvod = f => {
      if (f.cyklus) return f.cyklus.map(u => [u.bod[0], u.bod[1], u.h]);
      const body = [[f.h.a[0], f.h.a[1], 0], [f.h.b[0], f.h.b[1], 0], ...f.uzly.map(u => [u.bod[0], u.bod[1], u.h])];
      const ts = body.map(p => [dot(sub(p, f.h.a), f.h.v), p[2], p]);
      ts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      const Lb = ts[0], Rb = ts[ts.length - 1], d = [Rb[0] - Lb[0], Rb[1] - Lb[1]];
      const strana = x => cross(d, [x[0] - Lb[0], x[1] - Lb[1]]);              // < 0 = pod přímkou L→R
      const stred = ts.slice(1, -1);
      const spodni = stred.filter(x => strana(x) <= 0), horni = stred.filter(x => strana(x) > 0).reverse();
      return [Lb, ...spodni, Rb, ...horni].map(x => x[2]);
    };
    const vysledek = plochy.map(f => ({ a: f.h.a, b: f.h.b, stit: !!f.stit, body: obvod(f) }));
    // Kontrola: plochy (bez štítů) musí v půdoryse přesně pokrýt budovu, jinak výpočet nevyšel.
    const pl2 = b => Math.abs(b.reduce((s, p, i) => { const r = b[(i + 1) % b.length]; return s + p[0] * r[1] - r[0] * p[1]; }, 0)) / 2;
    const soucet = vysledek.reduce((s, f) => s + pl2(f.body), 0), cela = pl2(q);
    if (!isFinite(hmax) || hmax <= 0 || Math.abs(soucet - cela) > 0.01 * cela) return null;
    return { plochy: vysledek, hmax };
  }

  // 3D model budovy z půdorysu (metry, raději kolem počátku – kvůli přesnosti) a značek:
  // seznam ploch {body:[[x,y,z]…], barva, druh}; druh: 'stena' (stěny po obvodu), 'stit'
  // (štíty), 'strecha'. Poznámky = co bylo odhadnuto nebo zjednodušeno.
  function model3d(tags, pts) {
    const poznamky = [], plochy = [];
    if (!pts || pts.length < 3) return { plochy, poznamky: ['půdorys není k dispozici'] };
    // Půdorys vždy proti směru hodinových ručiček (kladná „Gaussova“ plocha). Pak u každé stěny
    // a→b víme, že vnější normála je (b.y−a.y, −(b.x−a.x)) – náhled podle ní skryje odvrácené stěny.
    if (pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) < 0) pts = pts.slice().reverse();
    const tvar = tags['roof:shape'] || 'flat';
    const fasada = barvaKresleni(tags['building:colour'], '#e6e1d6');
    const strecha = barvaKresleni(tags['roof:colour'], '#a5684a');
    const MIN = Math.max(cislo(tags.min_height) || 0, 0);

    // Osa hřebene: podél delší strany (výchozí), napříč, nebo kolmo na roof:direction
    // (u čtverce „delší strana“ neexistuje – tam rozhoduje směr spádu).
    const ob = obdelnik(pts);
    let r = [ob.ux, ob.uy];
    const smer = smerNaStupne(tags['roof:direction'] || '');
    if (tags['roof:orientation'] === 'across') r = [ob.vx, ob.vy];
    else if (tags['roof:orientation'] !== 'along' && smer !== null) {
      const t = smer * Math.PI / 180; r = [Math.cos(t), -Math.sin(t)];            // kolmo na spád
    }
    const pv = [-r[1], r[0]];
    // rozsah půdorysu v ose hřebene (u) a kolmo na ni (v)
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of pts) {
      const u = p[0] * r[0] + p[1] * r[1], v = p[0] * pv[0] + p[1] * pv[1];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, Lp = (u1 - u0) / 2, Sp = (v1 - v0) / 2;
    const bod = (u, v, z) => [(cu + u) * r[0] + (cv + v) * pv[0], (cu + u) * r[1] + (cv + v) * pv[1], z];

    // Spád pultové střechy: voda stéká ve směru d (od severu po směru hodin; x = východ, y = sever).
    const ds = smer === null ? Math.PI : smer * Math.PI / 180;                    // bez směru: na jih
    const dvec = [Math.sin(ds), Math.cos(ds)];
    const sp = pts.map(p => p[0] * dvec[0] + p[1] * dvec[1]);
    const sMin = Math.min(...sp), sMax = Math.max(...sp);

    // Půdorys, který není (skoro) obdélník – L, T, U, mnohoúhelník: valbu i sedlo spočítáme
    // rovným skeletem (jako F4map nebo Streets GL), ne nad obdélníkem kolem půdorysu.
    // Obdélníky dál kreslíme po staru – tam to sedí a funguje i roof:orientation.
    const plochaPud = Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    const sedlo = tvar === 'gabled' || tvar === 'gambrel';
    const skelet = ['hipped', 'mansard', 'half-hipped', 'gabled', 'gambrel'].includes(tvar) && plochaPud < 0.85 * ob.delka * ob.sirka
      ? rovnySkelet(pts, { stity: sedlo }) : null;

    // Výšky: střecha ze značky, ze sklonu, nebo odhad; celková výška ze značky, z podlaží, nebo 10 m.
    let RH = cislo(tags['roof:height']);
    const uhel = cislo(tags['roof:angle']);
    if (isNaN(RH) && tvar !== 'flat' && uhel > 0 && uhel < 90) {
      // vodorovná vzdálenost od okapu k hřebeni (u skeletu nejvzdálenější bod od zdí)
      const rozpeti = tvar === 'skillion' ? (sMax - sMin) : skelet ? skelet.hmax : (ORIENTOVATELNE.includes(tvar) ? Sp : ob.sirka / 2);
      RH = Math.tan(uhel * Math.PI / 180) * rozpeti;
    }
    let H = cislo(tags.height);
    if (isNaN(H)) {
      const lv = cislo(tags['building:levels']);
      if (lv > 0) { H = lv * 3 + (isNaN(RH) ? (tvar === 'flat' ? 0 : 3) : RH); poznamky.push('výška odhadnuta z podlaží (3 m na patro)'); }
      else { H = 10; poznamky.push('výška odhadnuta (10 m) – zadej height'); }
    }
    if (isNaN(RH)) { RH = tvar === 'flat' ? 0 : Math.min(3, (H - MIN) * 0.3); if (tvar !== 'flat') poznamky.push('výška střechy odhadnuta'); }
    RH = Math.min(Math.max(RH, 0), Math.max(H - MIN, 0));
    const W = H - RH;                                                              // horní hrana stěn

    // Horní hrana stěny v bodě i: u pultové stoupá od okapu (strana spádu) k vrcholu.
    const zTop = i => tvar === 'skillion' && sMax > sMin ? W + RH * (sMax - sp[i]) / (sMax - sMin) : W;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length, a = pts[i], b = pts[j];
      plochy.push({ druh: 'stena', barva: fasada, body: [[a[0], a[1], MIN], [b[0], b[1], MIN], [b[0], b[1], zTop(j)], [a[0], a[1], zTop(i)]] });
    }
    const S = (body, druh) => plochy.push({ druh: druh || 'strecha', barva: druh === 'stit' ? fasada : strecha, body });
    const c = teziste(pts);

    if (tvar === 'flat' || tvar === 'skillion' || RH <= 0) {
      S(pts.map((p, i) => [p[0], p[1], zTop(i)]));                                // rovina (vodorovná / šikmá)
    } else if (tvar === 'pyramidal' || tvar === 'cone') {
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; S([[a[0], a[1], W], [b[0], b[1], W], [c[0], c[1], H]]); }
    } else if (tvar === 'dome' || tvar === 'onion') {
      // Prstence od okapu k vrcholu; s = zmenšení ke středu, z = výška prstence.
      const n = 6, prstence = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const s = tvar === 'dome' ? Math.cos(t * Math.PI / 2) : Math.pow(1 - t, 0.9) * (1 + 0.6 * Math.sin(Math.PI * t));
        const z = tvar === 'dome' ? W + RH * Math.sin(t * Math.PI / 2) : W + RH * t;
        prstence.push(pts.map(p => [c[0] + s * (p[0] - c[0]), c[1] + s * (p[1] - c[1]), z]));
      }
      for (let k = 0; k < n; k++) for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        S([prstence[k][i], prstence[k][j], prstence[k + 1][j], prstence[k + 1][i]]);
      }
    } else if (tvar === 'round') {
      // Válcová: oblouk napříč hřebenem (6 pásů) + čelní výseče
      const n = 6, z = v => W + RH * Math.sqrt(Math.max(0, 1 - (v / Sp) * (v / Sp)));
      const prurez = [];
      for (let k = 0; k <= n; k++) { const v = -Sp + 2 * Sp * k / n; prurez.push([v, z(v)]); }
      for (let k = 0; k < n; k++) S([bod(-Lp, prurez[k][0], prurez[k][1]), bod(Lp, prurez[k][0], prurez[k][1]), bod(Lp, prurez[k + 1][0], prurez[k + 1][1]), bod(-Lp, prurez[k + 1][0], prurez[k + 1][1])]);
      for (const u of [-Lp, Lp]) S(prurez.map(([v, zz]) => bod(u, v, zz)), 'stit');
    } else if (skelet) {
      // Plochy rovného skeletu: výška h (sklon 45°) přepočtená tak, aby nejvyšší bod byl v H.
      // Normály dáme předem: střecha míří vždy nahoru, štít ven ze zdi. (Odhad „ven od středu
      // budovy“ v náhledu u L selhává – vnitřní kout leží blíž středu než zeď.)
      const k = RH / skelet.hmax;
      for (const f of skelet.plochy) {
        const body = f.body.map(([x, y, h]) => [x, y, W + h * k]);
        // rovnySkelet vrací obvod po směru hodin → vnějšek je vlevo od směru zdi a→b
        if (f.stit) plochy.push({ druh: 'stit', barva: fasada, body, ven: [-(f.b[1] - f.a[1]), f.b[0] - f.a[0]] });
        else plochy.push({ druh: 'strecha', barva: strecha, body, nahoru: true });
      }
      if (tvar !== 'hipped' && tvar !== 'gabled') poznamky.push('tvar ' + tvar + ' kreslím zjednodušeně jako ' + (sedlo ? 'sedlový' : 'valbový'));
    } else {
      // Sedlová a valbová rodina nad obdélníkem: valba = o kolik je hřeben kratší na každém konci.
      const valba = tvar === 'hipped' || tvar === 'mansard' ? Math.min(Sp, Lp) : (tvar === 'half-hipped' ? Math.min(Sp, Lp) * 0.5 : 0);
      if (!['gabled', 'gambrel', 'hipped', 'mansard', 'half-hipped'].includes(tvar)) poznamky.push('tvar ' + tvar + ' kreslím zjednodušeně jako sedlový');
      const hA = bod(-Lp + valba, 0, H), hB = bod(Lp - valba, 0, H);
      S([bod(-Lp, -Sp, W), bod(Lp, -Sp, W), hB, hA]);                             // jedna strana
      S([bod(Lp, Sp, W), bod(-Lp, Sp, W), hA, hB]);                               // druhá strana
      if (valba > 0) { S([bod(Lp, -Sp, W), bod(Lp, Sp, W), hB]); S([bod(-Lp, Sp, W), bod(-Lp, -Sp, W), hA]); }
      else { S([bod(Lp, -Sp, W), bod(Lp, Sp, W), hB], 'stit'); S([bod(-Lp, Sp, W), bod(-Lp, -Sp, W), hA], 'stit'); }
      if (plochaPud < 0.85 * (4 * Lp * Sp)) poznamky.push('střecha zjednodušeně nad obdélníkem kolem půdorysu');
    }
    return { plochy, poznamky };
  }

  // Ztmavení barvy "#rrggbb"/"#rgb" koeficientem k (0–1) → "rgb(…)" pro stínování ploch.
  function stin(hex, k) {
    let h = hex.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return `rgb(${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.round(v * k)).join(',')})`;
  }

  // Kresba modelů do SVG 300×200 ve „dvoubodové perspektivě“ (jako u architektonických
  // vizualizací): vzdálenější části se zmenšují, ale svislé hrany zůstávají svislé.
  // Model se otočí kolem svislé osy o azimut (°); kamera stojí na jihu, výš než budova,
  // a hledí na ni shora asi pod 30°. Odvrácené plochy se nekreslí; budovy se kreslí odzadu
  // dopředu a u každé nejdřív stěny, pak střecha. Plochy tmavnou podle toho, jak se
  // odvracejí od světla. Měřítko nezávisí na natočení (při otáčení myší obraz nepulzuje).
  function svg3d(modely, azimut) {
    const plochy = modely.flatMap(m => m.plochy);
    const hlava = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" class="bp-3d-svg">';
    if (!plochy.length) return hlava + '<text x="150" y="100" text-anchor="middle" font-size="11" fill="#777">bez půdorysu</text></svg>';
    const vse = plochy.flatMap(f => f.body);
    const x0 = (Math.min(...vse.map(b => b[0])) + Math.max(...vse.map(b => b[0]))) / 2;
    const y0 = (Math.min(...vse.map(b => b[1])) + Math.max(...vse.map(b => b[1]))) / 2;
    const R = Math.max(1, ...vse.map(b => Math.hypot(b[0] - x0, b[1] - y0)));
    const Hm = Math.max(1, ...vse.map(b => b[2]));
    // Kamera: vodorovně Dh jižně od středu (4× poloměr scény – menší = víc zkreslení, jako širokoúhlý objektiv),
    // ve výšce zc. Promítání dělí jen VODOROVNOU hloubkou (y + Dh), ne skutečnou vzdáleností
    // → body nad sebou mají stejné x na obrazovce, tj. svislé hrany zůstanou svislé.
    const Dh = 4 * Math.hypot(R, Hm * 0.6), zc = Hm * 0.4 + Dh * Math.tan(30 * Math.PI / 180);
    const cam = [0, -Dh, zc];
    const promitni = q => { const h = q[1] + Dh; return [q[0] / h, -(q[2] - zc) / h]; };
    const otoc = (b, a) => { const x = b[0] - x0, y = b[1] - y0, c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c, b[2]]; };
    // Měřítko a posun spočítáme přes všechna natočení po 15°, aby se kresba vešla vždy.
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (let az = 0; az < 360; az += 15) for (const b of vse) {
      const q = promitni(otoc(b, az * Math.PI / 180));
      mnx = Math.min(mnx, q[0]); mxx = Math.max(mxx, q[0]); mny = Math.min(mny, q[1]); mxy = Math.max(mxy, q[1]);
    }
    const k = Math.min(280 / (mxx - mnx || 1), 180 / (mxy - mny || 1)), sx = (mnx + mxx) / 2, sy = (mny + mxy) / 2;
    const naObrazovku = p => { const q = promitni(p); return (150 + (q[0] - sx) * k).toFixed(1) + ',' + (100 + (q[1] - sy) * k).toFixed(1); };
    const a = azimut * Math.PI / 180;
    const svetlo = (() => { const v = [-0.4, -0.5, 0.75], d = Math.hypot(...v); return v.map(c => c / d); })();
    const skal = (u, w) => u[0] * w[0] + u[1] * w[1] + u[2] * w[2];                 // skalární součin
    const prumer = b => [0, 1, 2].map(i => b.reduce((s, p) => s + p[i], 0) / b.length);
    // Normála plochy z prvních bodů, které neleží na přímce (vektorový součin); null = plocha bez obsahu.
    const normala = b => {
      for (let i = 2; i < b.length; i++) {
        const u = [b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2]], w = [b[i][0] - b[0][0], b[i][1] - b[0][1], b[i][2] - b[0][2]];
        const c = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], d = Math.hypot(...c);
        if (d > 1e-9) return c.map(x => x / d);
      }
      return null;
    };
    const budovy = modely.filter(m => m.plochy.length).map(m => {
      const b3 = m.plochy.map(f => f.body.map(p => otoc(p, a)));
      const z = b3.flat().map(p => p[2]);
      const stred = prumer(b3.flat()); stred[2] = (Math.min(...z) + Math.max(...z)) / 2;
      const steny = [], strechy = [];
      m.plochy.forEach((f, i) => {
        const b = b3[i], t = prumer(b);
        let n = normala(b);
        if (!n) return;
        // Stěny: půdorys je proti směru hodin, takže normála už míří ven (platí i u budov do L,
        // kde by „ven od středu“ selhalo). Střechy a štíty: otočíme ji ven od středu budovy.
        // Když model3d směr plochy zná (rovný skelet), použijeme ho: střecha nahoru, štít ven
        // (vektor ven natočíme stejně jako body). Jinak odhad „ven od středu budovy“.
        if (f.nahoru) { if (n[2] < 0) n = n.map(x => -x); }
        else if (f.ven) { const vr = [f.ven[0] * Math.cos(a) - f.ven[1] * Math.sin(a), f.ven[0] * Math.sin(a) + f.ven[1] * Math.cos(a)]; if (n[0] * vr[0] + n[1] * vr[1] < 0) n = n.map(x => -x); }
        else if (f.druh !== 'stena' && skal(n, [t[0] - stred[0], t[1] - stred[1], t[2] - stred[2]]) < 0) n = n.map(x => -x);
        if (skal(n, [cam[0] - t[0], cam[1] - t[1], cam[2] - t[2]]) <= 0) return;  // odvrácená od kamery
        const jas = 0.55 + 0.45 * Math.abs(skal(n, svetlo));
        (f.druh === 'strecha' ? strechy : steny).push({ h: t[1], svg: `<polygon points="${b.map(naObrazovku).join(' ')}" fill="${stin(f.barva, jas)}" stroke="#333" stroke-width="0.4" stroke-linejoin="round"/>` });
      });
      const odzadu = (p, q) => q.h - p.h;                                          // větší y = dál od kamery
      // obdélník kolem budovy v natočených souřadnicích – kvůli poznání „co stojí na čem“
      const xs = b3.flat().map(p => p[0]), ys = b3.flat().map(p => p[1]);
      return { h: stred[1], zMin: Math.min(...z), zMax: Math.max(...z), x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys),
        svg: steny.sort(odzadu).concat(strechy.sort(odzadu)).map(x => x.svg).join('') };
    });
    // p „stojí na“ q: začíná až nahoře na q a půdorysem se vejde nad q (tolerance 0,5 m) – kopule
    // na tamburu, cibule na věži, lucerna na kopuli. Ta se kreslí až po q, jinak ji zakryje
    // střecha q. Ostatní budovy odzadu dopředu podle středu.
    // ponytail: přibližné pořadí (malířův algoritmus) – u hodně se prolínajících tvarů může
    // kousek přečnívat špatně; přesné řešení by byl z-buffer (canvas/WebGL).
    const naNi = (p, q) => p.zMin >= q.zMax - 0.5 && p.x0 >= q.x0 - 0.5 && p.x1 <= q.x1 + 0.5 && p.y0 >= q.y0 - 0.5 && p.y1 <= q.y1 + 0.5;
    budovy.sort((p, q) => naNi(p, q) ? 1 : naNi(q, p) ? -1 : q.h - p.h);
    return hlava + budovy.map(x => x.svg).join('') + '</svg>';
  }

  // Kontrola PŘED zápisem: vrátí důvod, proč panel nesmí zapsat, nebo null.
  // Panel přepisuje celý text značek, takže cokoliv, co by se při převodu změnilo,
  // by změnil i bez vědomí uživatele:
  //  - mezera na okraji klíče/hodnoty: parser ji ořízne → potichu by "opravil" i značku,
  //    na kterou uživatel nesáhl (iD ořezává stejně, takže se to nedá obejít);
  //  - hodnota "*": iD tak ukazuje smíšené hodnoty při výběru více prvků → zápis by
  //    všem vybraným prvkům přepsal skutečné hodnoty (zjištěno revizí 2026-11-23).
  //  - VÝJIMKA hromadne=true: iD neměněné řádky "klíč=*" při zápisu přeskočí (ověřeno ve
  //    zdrojáku iD 2.42.3, raw_tag_editor.js → textChanged) → panel je jen nesmí vynechat.
  function duvodNezapsat(text, hromadne) {
    for (const radek of String(text).split('\n')) {
      if (!radek.trim()) continue;                      // prázdné řádky nevadí
      const i = radek.indexOf('=');
      const klic = i < 0 ? radek : radek.slice(0, i);
      const hodnota = i < 0 ? '' : radek.slice(i + 1);
      if (klic !== klic.trim() || hodnota !== hodnota.trim()) {
        return 'Značka „' + radek.trim() + '“ má mezeru na začátku nebo konci. Panel by ji při zápisu změnil, proto nic nezapíše – oprav ji nejdřív v iD.';
      }
      if (hodnota === '*' && !hromadne) {
        return 'Je vybráno víc prvků s různými hodnotami (' + klic.trim() + '=*). Panel funguje jen pro jeden prvek.';
      }
    }
    return null;
  }

  // Nová hodnota podlaží po kliknutí na −/+. Vrací text k zápisu, '' = smazat značku,
  // null = nic nezapisovat. Necelá/složená čísla ("2.5", "3;4") panel nepřepisuje,
  // protože by z nich udělal něco jiného, než tam je (zjištěno revizí).
  function krokPodlazi(ted, krok, klic) {
    if (ted === undefined || ted === '') {
      if (krok < 0) return null;                        // "−" u nevyplněného = nic (0 by něco znamenalo)
      ted = '0';
    }
    if (!/^\d+$/.test(ted)) return null;
    const nove = Number(ted) + krok;
    if (nove < 0) return null;
    // 0 střešních / spodních podlaží = značka nemá smysl → smazat; building:levels=0 je platné
    if (nove === 0 && klic !== 'building:levels') return '';
    return String(nove);
  }

  // Escapování textu pro vložení do HTML/SVG – hodnoty značek píšou cizí lidé,
  // nesmí se z nich stát kód stránky.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Barva pro kreslení: známý název z palety → jeho hex, "#abc"/"#aabbcc" → přímo,
  // cokoliv jiného (neznámý název, nesmysl) → náhradní barva. Do SVG tak nikdy
  // nejde neověřený text.
  function barvaKresleni(hodnota, nahradni) {
    if (!hodnota) return nahradni;
    const znama = COLOURS.find(c => c.value === hodnota);
    if (znama) return znama.hex;
    return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hodnota) ? hodnota : nahradni;
  }

  // Obrys střechy v bočním pohledu. Budova je široká od x0 do x1, střecha sahá
  // od yb (spodek = horní hrana zdí) do yt (vrchol). Vrací "d" pro <path>.
  // Kresby jsou schematické – jde o to, aby tvary šly od sebe rozeznat.
  function obrysStrechy(tvar, x0, x1, yb, yt) {
    const xm = (x0 + x1) / 2, w = x1 - x0, d = yb - yt;
    const x = f => (x0 + w * f).toFixed(1);            // bod ve zlomku šířky
    const y = f => (yb - d * f).toFixed(1);            // bod ve zlomku výšky střechy
    switch (tvar) {
      case 'gabled': return `M${x0} ${yb} L${xm} ${yt} L${x1} ${yb} Z`;
      case 'hipped': return `M${x0} ${yb} L${x(0.25)} ${yt} L${x(0.75)} ${yt} L${x1} ${yb} Z`;
      case 'half-hipped': return `M${x0} ${yb} L${x(0.38)} ${y(0.8)} L${xm} ${yt} L${x(0.62)} ${y(0.8)} L${x1} ${yb} Z`;
      case 'pyramidal': return `M${x0} ${yb} L${xm} ${yt} L${x1} ${yb} Z M${xm} ${yt} L${xm} ${yb}`;
      case 'skillion': return `M${x0} ${yb} L${x0} ${yt} L${x1} ${yb} Z`;
      case 'gambrel': return `M${x0} ${yb} L${x(0.15)} ${y(0.6)} L${xm} ${yt} L${x(0.85)} ${y(0.6)} L${x1} ${yb} Z`;
      case 'mansard': return `M${x0} ${yb} L${x(0.08)} ${y(0.75)} L${x(0.3)} ${yt} L${x(0.7)} ${yt} L${x(0.92)} ${y(0.75)} L${x1} ${yb} Z`;
      case 'dome': return `M${x0} ${yb} A${w / 2} ${d} 0 0 1 ${x1} ${yb} Z`;
      case 'onion': return `M${x0} ${yb} C${x(-0.25)} ${y(0.45)} ${x(0.45)} ${y(0.7)} ${xm} ${yt} C${x(0.55)} ${y(0.7)} ${x(1.25)} ${y(0.45)} ${x1} ${yb} Z`;
      case 'round': return `M${x0} ${yb} A${w / 2} ${d} 0 0 1 ${x1} ${yb} Z M${x0} ${y(0.5)} L${x1} ${y(0.5)}`;
      case 'cone': return `M${x0} ${yb} L${xm} ${yt} L${x1} ${yb} Q${xm} ${(yb + 6).toFixed(1)} ${x0} ${yb} Z`;
      default: return `M${x0} ${yb} L${x1} ${yb}`;     // flat a neznámé tvary: jen čára
    }
  }

  // Boční řez budovy jako SVG (220×160). Kreslí v měřítku: zdi od min_height
  // do (height − roof:height), nad nimi střechu, vpravo kóty. Texty kót nesou
  // data-klic, aby panel po kliknutí věděl, které pole zaměřit.
  function svgRez(tags) {
    const tvar = tags['roof:shape'] || 'flat';
    const zadanaH = !isNaN(cislo(tags.height));
    const H = zadanaH && cislo(tags.height) > 0 ? cislo(tags.height) : 10;      // bez výšky kreslíme 10 m
    let RH = cislo(tags['roof:height']);
    const odhadRH = isNaN(RH) && tvar !== 'flat';
    if (isNaN(RH)) RH = tvar === 'flat' ? 0 : H * 0.3;                          // odhad pro kresbu
    RH = Math.min(Math.max(RH, 0), H);                                          // nikdy mimo budovu
    const MIN = Math.min(Math.max(cislo(tags.min_height) || 0, 0), H);

    const zem = 145, s = 120 / H;                      // y země a měřítko (px na metr)
    const y = m => +(zem - m * s).toFixed(1);
    const x0 = 50, x1 = 150;
    const yZdiNahore = y(H - RH), yZdiDole = y(MIN), yVrchol = y(H);
    const fasada = barvaKresleni(tags['building:colour'], '#e6e1d6');
    const strecha = barvaKresleni(tags['roof:colour'], '#a5684a');

    const kota = (klic, odM, doM, xk, text) => {
      const ya = y(odM), yb = y(doM), ys = ((ya + yb) / 2).toFixed(1);
      return `<line x1="${xk}" y1="${ya}" x2="${xk}" y2="${yb}" stroke="#555" stroke-width="1" marker-start="url(#bp-sip)" marker-end="url(#bp-sip)"/>` +
        `<text x="${xk + 4}" y="${ys}" data-klic="${klic}" class="bp-kota">${esc(text)}</text>`;
    };

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 160" class="bp-rez">` +
      `<defs><marker id="bp-sip" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto"><circle cx="3" cy="3" r="2" fill="#555"/></marker></defs>` +
      `<line x1="10" y1="${zem}" x2="210" y2="${zem}" stroke="#7a6a50" stroke-width="2"/>` +
      (MIN > 0 ? `<rect x="${x0}" y="${yZdiDole}" width="${x1 - x0}" height="${(zem - yZdiDole).toFixed(1)}" fill="none" stroke="#999" stroke-dasharray="3 3"/>` : '') +
      `<rect x="${x0}" y="${yZdiNahore}" width="${x1 - x0}" height="${Math.max(yZdiDole - yZdiNahore, 0).toFixed(1)}" fill="${fasada}" stroke="#444"/>` +
      `<path d="${obrysStrechy(tvar, x0, x1, yZdiNahore, yVrchol)}" fill="${strecha}" stroke="#444" stroke-width="${tvar === 'flat' ? 3 : 1}"/>` +
      kota('height', 0, H, 165, zadanaH ? 'height ' + H + ' m' : 'výška nezadána') +
      (RH > 0 ? kota('roof:height', H - RH, H, 8, (odhadRH ? '? ' : '') + RH.toFixed(1).replace('.0', '') + ' m') : '') +
      (MIN > 0 ? kota('min_height', 0, MIN, 8, MIN + ' m') : '') +
      `</svg>`;
  }

  /* ======================================================================
   * Export pro test v Node. V prohlížeči "module" neexistuje → přeskočí se
   * a pokračuje se spuštěním panelu na stránce.
   * ==================================================================== */
  const API = { ROOF_SHAPES, MATERIALS_BUILDING, MATERIALS_ROOF, COLOURS, parseTagText, serializeTags, applyChanges, normalizeNumber, checkWarnings, svgRez, obrysStrechy, duvodNezapsat, krokPodlazi,
    PREDVOLBY, SMERY, predvolbaZmeny, vypoctiVysku, vyskaPatra, navrhTypu, smerNaStupne, bezOken, zmenyOkna, zmenyPrujezd,
    ORIENTOVATELNE, otocO180, mNaPx, pudorysZCesty, obdelnik, model3d, svg3d, rovnySkelet };
  if (typeof module === 'object' && module.exports) { module.exports = API; return; }

  /* ======================================================================
   * 2) MOST K iD
   * Všechny selektory (třídy prvků iD) jsou JEN TADY – když OSM nasadí novou
   * verzi iD a panel přestane fungovat, opravuje se toto místo.
   * ==================================================================== */
  const SEL = {
    sekceZnacky: '.section-raw-tag-editor',          // sekce "Značky" v editoru prvku
    textarea: '.section-raw-tag-editor textarea.tag-text', // textové zobrazení značek
    rozbalit: '.section-raw-tag-editor .hide-toggle', // nadpis sekce (rozbalí/sbalí)
    teloEditoru: '.entity-editor-pane .inspector-body', // sem vkládáme náš panel
    sidebar: '.sidebar'                               // boční panel – sledujeme jeho změny
  };

  // Najde textové pole značek. Sekce "Značky" MUSÍ být rozbalená: ve sbalené sekci
  // iD pole nepřekresluje a zůstávají v něm staré hodnoty (ověřeno živě – po Zpět tam
  // byla pořád vrácená hodnota; zápis by ji omylem obnovil). Proto sbalenou sekci vždy
  // rozbalíme kliknutím na nadpis (iD si to zapamatuje, jako by klikl uživatel).
  // Pole existuje i při zobrazení "seznam" – je jen skryté, zápis do něj funguje.
  function najdiTextarea() {
    const nadpis = document.querySelector(SEL.rozbalit);
    if (!nadpis) return null;
    if (!nadpis.classList.contains('expanded')) nadpis.click(); // iD sekci vykreslí synchronně
    return document.querySelector(SEL.textarea);
  }

  // Aktuální značky vybraného prvku (jak je ukazuje iD, včetně neuložených změn).
  function nactiZnacky() {
    const ta = najdiTextarea();
    return ta ? parseTagText(ta.value) : null;
  }

  // Zapíše kompletní novou sadu značek. iD si samo spočítá rozdíl proti stávajícím
  // značkám a provede ho jako jednu úpravu (jeden krok Zpět).
  function zapisZnacky(noveTags, hromadne) {
    const ta = najdiTextarea();
    if (!ta) return false;
    const duvod = duvodNezapsat(ta.value, hromadne); // pojistka proti nechtěné změně jiných značek
    if (duvod) { zobrazZpravu(duvod); return false; }
    ta.value = serializeTags(noveTags);
    ta.dispatchEvent(new Event('change'));            // na "change" iD reaguje funkcí textChanged
    return true;
  }

  // Výběr z adresy: iD tam píše "id=w357664858", při výběru více prvků "id=w1,w2,…".
  // Vrací { id: celý text výběru nebo null, pocet: kolik prvků je vybráno }.
  function vyberInfo() {
    const m = location.hash.match(/[#&]id=([^&]*)/);
    const id = m ? decodeURIComponent(m[1]) : '';
    return id ? { id, pocet: id.split(',').length } : { id: null, pocet: 0 };
  }

  // Půdorys cesty (budovy) tak, jak ji iD právě kreslí v mapě – i s neuloženými úpravami.
  // Vrací { pts: body v metrech (vůči rohu obrazovky), orez: budova přesahuje výřez } nebo null
  // (relace, bod, budova mimo výřez). Měřítko px → m bereme ze zoomu a šířky v adrese.
  function nactiPudorys(id) {
    if (!/^w-?\d+$/.test(id)) return null;
    const path = document.querySelector(`.layer-osm path.area.stroke.${id}`) || document.querySelector(`.layer-osm path.stroke.${id}`);
    const m = location.hash.match(/map=([\d.]+)\/([\d.-]+)\//);
    if (!path || !m) return null;
    const pts = pudorysZCesty(path.getAttribute('d'), mNaPx(Number(m[1]), Number(m[2])));
    if (pts.length < 3) return null;
    // iD ořezává cesty na okraji mapy → budova, která přesahuje výřez, by měla useknutý půdorys
    const mapa = document.querySelector('.main-map'), r = path.getBoundingClientRect(), mr = mapa ? mapa.getBoundingClientRect() : r;
    const orez = r.left < mr.left + 1 || r.top < mr.top + 1 || r.right > mr.right - 1 || r.bottom > mr.bottom - 1;
    return { pts, orez };
  }

  // Uložené značky budov z OSM API – pro náhled více vybraných budov (iD u nich ukazuje
  // rozdílné hodnoty jen jako "*"). Načítá se jednou na budovu; po načtení se panel překreslí.
  const ulozene = {};
  let nacitamUlozene = false;
  function nactiUlozene(ids) {
    const chybi = ids.filter(id => /^w\d+$/.test(id) && !(id in ulozene));
    if (!chybi.length || nacitamUlozene) return;
    nacitamUlozene = true;
    fetch('https://api.openstreetmap.org/api/0.6/ways.json?ways=' + chybi.map(i => i.slice(1)).join(','))
      .then(r => r.json())
      .then(j => { for (const e of j.elements || []) ulozene['w' + e.id] = e.tags || {}; })
      .catch(() => {})
      .finally(() => { for (const id of chybi) if (!(id in ulozene)) ulozene[id] = {}; nacitamUlozene = false; posledniKlic = null; });
  }

  // Volá callback(vyberInfo()), kdykoliv se v bočním panelu něco změní (výběr, přerenderování,
  // úprava značek). Změna hodnoty textového pole není změna DOM, proto posloucháme
  // i události input/change. Debounce 150 ms: iD při překreslení mění DOM mnohokrát
  // za sebou, stačí nám zareagovat jednou, až se uklidní.
  function sledujVyber(callback) {
    let casovac = null;
    const naplanuj = () => { clearTimeout(casovac); casovac = setTimeout(() => callback(vyberInfo()), 150); };
    const napoj = () => {
      const sidebar = document.querySelector(SEL.sidebar);
      if (!sidebar) { setTimeout(napoj, 500); return; } // iD se ještě nenačetl → zkusit později
      new MutationObserver(naplanuj).observe(sidebar, { childList: true, subtree: true });
      sidebar.addEventListener('change', naplanuj, true);
      sidebar.addEventListener('input', naplanuj, true);
      window.addEventListener('hashchange', naplanuj);
      // Pojistka: Zpět/Vpřed ani změna adresy přes history.replaceState (iD ji navíc
      // aktualizuje se zpožděním) nevyvolají žádnou z událostí výše → kontrolovat
      // i pravidelně. Je to levné – panel se překreslí jen když se něco změnilo.
      setInterval(naplanuj, 400);
      naplanuj();
    };
    napoj();
  }

  /* ======================================================================
   * 3) PANEL
   * ==================================================================== */

  // Styly panelu – vloží se jednou do <head>. Třídy mají předponu "bp-", aby se
  // nepletly se styly iD.
  const STYL = `
    #budova-panel { margin: 10px 20px 14px; padding: 10px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fafafa; font-size: 12px; }
    #budova-panel h3 { margin: 0 0 6px; font-size: 14px; }
    #budova-panel .bp-rez { width: 100%; max-width: 330px; display: block; margin: 0 auto; }
    #budova-panel .bp-kota { font-size: 9px; fill: #222; cursor: pointer; text-decoration: underline dotted; }
    #budova-panel .bp-sekce { margin-top: 10px; }
    #budova-panel .bp-sekce > b { display: block; margin-bottom: 4px; }
    #budova-panel .bp-klic { color: #888; font-size: 10px; font-family: monospace; }
    #budova-panel .bp-radek { display: flex; align-items: center; gap: 6px; margin: 3px 0; flex-wrap: wrap; }
    #budova-panel .bp-radek label { min-width: 120px; }
    #budova-panel input.bp-cislo { width: 60px; }
    #budova-panel input.bp-chyba { border: 2px solid #d32f2f; background: #fdecea; }
    #budova-panel .bp-strechy { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
    #budova-panel .bp-strechy button { height: auto; padding: 3px 2px; font-size: 10px; line-height: 1.2; background: #fff; border: 1px solid #ccc; border-radius: 4px; }
    #budova-panel .bp-strechy button.bp-aktivni { border: 2px solid #2b7bd6; background: #e8f1fc; font-weight: bold; }
    #budova-panel .bp-strechy svg { width: 40px; height: 26px; display: block; margin: 0 auto; }
    #budova-panel .bp-vzorek { width: 18px; height: 18px; padding: 0; border: 1px solid #888; border-radius: 3px; min-width: 0; }
    #budova-panel .bp-vzorek.bp-aktivni { outline: 2px solid #2b7bd6; outline-offset: 1px; }
    #budova-panel .bp-krok { width: 24px; height: 24px; padding: 0; min-width: 0; }
    #budova-panel .bp-upozorneni { margin: 3px 0; padding: 4px 6px; background: #fff4d6; border-left: 3px solid #e0a800; }
    #budova-panel details { margin-top: 8px; }
    #budova-panel .bp-zprava { margin-bottom: 8px; padding: 6px 8px; background: #fdecea; border-left: 3px solid #d32f2f; color: #8a1c1c; }
    #budova-panel select { max-width: 170px; }
    #budova-panel .bp-typy { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; }
    #budova-panel .bp-typy button, #budova-panel .bp-smery button { height: auto; padding: 4px; font-size: 11px; background: #fff; border: 1px solid #ccc; border-radius: 4px; }
    #budova-panel .bp-typy button.bp-navrh { border: 2px solid #2e9d4b; background: #eaf7ee; }
    #budova-panel .bp-smery { display: inline-grid; grid-template-columns: repeat(8, auto); gap: 2px; }
    #budova-panel .bp-smery button { min-width: 0; padding: 2px 5px; }
    #budova-panel .bp-smery button.bp-aktivni { border: 2px solid #2b7bd6; background: #e8f1fc; font-weight: bold; }
    #budova-panel .bp-info { color: #555; font-size: 11px; }
    /* samostatná tlačítka (Dopočítat výšku, Část nad průjezdem, věž) – iD by z nich udělalo holý text */
    #budova-panel button.bp-tl { height: auto; min-width: 0; padding: 3px 8px; font-size: 11px; color: #2b7bd6; background: #fff; border: 1px solid #2b7bd6; border-radius: 4px; }
    #budova-panel button.bp-tl.bp-aktivni { color: #fff; background: #2b7bd6; }
    #budova-panel .bp-3d-obal { border: 1px solid #ddd; border-radius: 4px; background: linear-gradient(#e9f1fa, #fbfcfd); cursor: grab; user-select: none; }
    #budova-panel .bp-3d-obal svg { width: 100%; display: block; }
  `;

  // Popisky polí pro výšky (pořadí = pořadí v panelu) a podlaží.
  const VYSKY = [
    { klic: 'height', label: 'Celková výška', napoveda: 'od země po vrchol střechy (m)' },
    { klic: 'roof:height', label: 'Výška střechy', napoveda: 'od okapu po vrchol (m)' },
    { klic: 'min_height', label: 'Spodní hrana', napoveda: 'jen u částí nad zemí, např. přesah (m)' }
  ];
  const PODLAZI = [
    { klic: 'building:levels', label: 'Podlaží', napoveda: 'nad zemí, bez střechy' },
    { klic: 'roof:levels', label: 'Podlaží ve střeše', napoveda: 'obytné podkroví' },
    { klic: 'building:min_level', label: 'Začíná od podlaží', napoveda: 'jen u částí budovy', jenCast: true },
    { klic: 'building:levels:underground', label: 'Podzemní podlaží', napoveda: 'sklepy, podzemní garáže' }
  ];

  // Tlačítka předvoleb typů budov. navrh = id typu, který panel zvýrazní (podle značek).
  // Kostel nemá hodnoty – jen otevře návod na části budovy (věže, loď).
  function htmlTypu(navrh) {
    let h = `<div class="bp-typy">`;
    for (const p of PREDVOLBY) {
      h += `<button type="button" class="${p.id === navrh ? 'bp-navrh' : ''}" data-akce="typ" data-hodnota="${p.id}" ` +
        `title="Doplní jen prázdné hodnoty${p.id === navrh ? ' – podle značek to vypadá na tento typ' : ''}">${p.label}</button>`;
    }
    return h + `<button type="button" data-akce="kostel" title="Kostely se skládají z částí – otevře návod">Kostel</button></div>`;
  }

  // Přepínač „bez oken“ (window=no). Při hromadném výběru se smíšenou hodnotou ("*")
  // je nezaškrtnutý – zaškrtnutí pak zapíše window=no všem vybraným.
  function htmlOkna(tags) {
    return `<div class="bp-radek"><label><input type="checkbox" class="bp-okna"${bezOken(tags) ? ' checked' : ''}> Bez oken</label>` +
      `<span class="bp-klic">window=no – sklady, trafostanice, garáže; 3D mapy pak nekreslí okna</span></div>`;
  }

  // Natočení 3D náhledu (°) a naposledy kreslené modely – drží se mezi překresleními panelu,
  // aby otáčení myší nemuselo pokaždé znovu skládat celý panel.
  let azimut3d = 30;
  let modely3d = [];
  const prekresli3d = () => {
    const o = document.querySelector('#budova-panel .bp-3d-obal');
    if (o) o.innerHTML = svg3d(modely3d, azimut3d);
  };

  // Sekce „3D náhled“: kresba + otáčení + (u uložené budovy) věrný náhled v OSMBuilding.
  function htmlNahledu(modely, poznamky, vernyId) {
    modely3d = modely;
    let h = `<div class="bp-sekce"><b>3D náhled</b> <span class="bp-info">živě, i s neuloženými změnami – otáčej tažením myši</span>` +
      `<div class="bp-3d-obal">${svg3d(modely, azimut3d)}</div><div class="bp-radek">` +
      `<button type="button" class="bp-tl" data-akce="otoc3d" data-krok="-30" title="otočit doleva">⟲</button>` +
      `<button type="button" class="bp-tl" data-akce="otoc3d" data-krok="30" title="otočit doprava">⟳</button>`;
    if (vernyId) h += `<button type="button" class="bp-tl" data-akce="verny" data-hodnota="${esc(vernyId)}" title="OSMBuilding v novém okně – i části budovy (věže), ale jen uložená data">Věrný náhled (uložený stav)</button>`;
    h += `</div>`;
    for (const p of [...new Set(poznamky)]) h += `<div class="bp-info">ℹ ${esc(p)}</div>`;
    return h + `</div>`;
  }

  // Zúžený panel při výběru více budov: jen to, co jde bezpečně zapsat všem najednou.
  function htmlHromadne(tags, pocet, nahled) {
    let h = `<h3>🏘 Vybráno ${pocet} prvků</h3>` + nahled;
    if (!tags.building || tags.building === '*') {
      // Smíšené building= (nebo nejsou všechno budovy) – nevíme, jestli by se střecha
      // nezapsala třeba i silnici, proto nic nenabízet.
      return h + `<div class="bp-info">Hromadné předvolby fungují jen pro budovy se <b>stejnou</b> hodnotou building= ` +
        `(teď ${tags.building ? 'se liší' : 'chybí'}). Vyber jen budovy jednoho typu.</div>`;
    }
    h += `<div class="bp-sekce"><b>Typ budovy</b> <span class="bp-info">doplní všem vybraným jen značky, které nemá žádná z nich; výšku hromadně nepočítá</span>${htmlTypu(navrhTypu(tags))}</div>`;
    h += `<div class="bp-sekce">${htmlOkna(tags)}</div>`;
    return h;
  }

  // Výchozí výška patra pro dopočet: podle zvýrazněného typu, jinak 3 m.
  const vychoziPatro = tags => (PREDVOLBY.find(p => p.id === navrhTypu(tags)) || { patro: 3 }).patro;

  // Jedno ikonové tlačítko tvaru střechy (malé SVG se stejným obrysem jako v řezu).
  function ikonaStrechy(tvar) {
    return `<svg viewBox="0 0 60 36"><rect x="10" y="22" width="40" height="12" fill="#e6e1d6" stroke="#444"/>` +
      `<path d="${obrysStrechy(tvar, 10, 50, 22, 4)}" fill="#a5684a" stroke="#444" stroke-width="${tvar === 'flat' ? 3 : 1}"/></svg>`;
  }

  // Sestaví HTML celého panelu z aktuálních značek. Nic nezapisuje – jen kreslí.
  function htmlPanelu(tags, nahled) {
    const jeCast = tags['building:part'] !== undefined;
    const nazev = tags.name ? ' – ' + esc(tags.name) : '';
    let h = `<h3>🏠 ${jeCast ? 'Část budovy' : 'Budova'}${nazev}</h3>` + (nahled || '');

    // Předvolby typů (jen u celé budovy – části mají vlastní logiku: věže, průjezdy)
    if (!jeCast) {
      h += `<div class="bp-sekce"><b>Typ budovy</b> <span class="bp-info">doplní jen prázdné hodnoty – ověř je na ortofotu</span>${htmlTypu(navrhTypu(tags))}</div>`;
    }

    // Boční řez + pole výšek (klik na kótu v řezu zaměří odpovídající pole)
    h += svgRez(tags);
    h += `<div class="bp-sekce"><b>Výšky</b>`;
    for (const v of VYSKY) {
      if (v.klic === 'min_height' && !jeCast && tags.min_height === undefined) continue; // u celé budovy obvykle nedává smysl
      h += `<div class="bp-radek"><label>${v.label}</label>` +
        `<input class="bp-cislo" data-klic="${v.klic}" value="${esc(tags[v.klic] || '')}" placeholder="?"> m ` +
        `<span class="bp-klic">${v.klic} – ${v.napoveda}</span></div>`;
    }
    // Dopočet výšky z podlaží. Pole „výška patra“ NENÍ značka OSM – jen vstup do výpočtu
    // (proto nemá data-klic a onZmena ho nezapisuje).
    const patroZDat = vyskaPatra(tags);
    h += `<div class="bp-radek"><label>Výška patra</label>` +
      `<input class="bp-cislo bp-patro" value="${vychoziPatro(tags)}"> m ` +
      `<button type="button" class="bp-tl" data-akce="vyska" title="height = podlaží × výška patra + výška střechy (přepíše height)">Dopočítat výšku</button>` +
      `<span class="bp-info">${patroZDat !== null ? 'z dat vychází ' + esc(zaokrouhli(patroZDat)) + ' m na patro' : 'jen pomůcka pro výpočet, do OSM se nezapisuje'}</span></div>`;
    h += `</div>`;

    // Tvar střechy – mřížka obrázkových tlačítek
    h += `<div class="bp-sekce"><b>Tvar střechy</b> <span class="bp-klic">roof:shape</span><div class="bp-strechy">`;
    for (const r of ROOF_SHAPES) {
      const aktivni = tags['roof:shape'] === r.value ? ' bp-aktivni' : '';
      h += `<button type="button" class="${aktivni}" data-akce="strecha" data-hodnota="${r.value}" title="roof:shape=${r.value}">${ikonaStrechy(r.value)}${r.label}</button>`;
    }
    h += `</div>`;
    // Sklon (alternativa k roof:height) – u ploché střechy nemá smysl
    if (tags['roof:shape'] && tags['roof:shape'] !== 'flat') {
      h += `<div class="bp-radek"><label>Sklon střechy</label>` +
        `<input class="bp-cislo" data-klic="roof:angle" value="${esc(tags['roof:angle'] || '')}" placeholder="?"> ° ` +
        `<span class="bp-klic">roof:angle – stačí zadat buď sklon, nebo výšku střechy</span></div>`;
    }
    // Směr spádu – jen u pultové střechy (u ostatních tvarů určuje hřeben roof:orientation)
    if (tags['roof:shape'] === 'skillion') {
      const ted = smerNaStupne(tags['roof:direction'] || '');
      h += `<div class="bp-radek"><label>Spád střechy k</label><span class="bp-smery">`;
      for (const s of SMERY) {
        h += `<button type="button" class="${ted === s.deg ? 'bp-aktivni' : ''}" data-akce="smer" data-hodnota="${s.deg}" title="roof:direction=${s.deg}">${s.label}</button>`;
      }
      h += `</span><button type="button" class="bp-tl" data-akce="otoc180" title="spád na opačnou stranu">Otočit o 180°</button>` +
        `<span class="bp-klic">roof:direction – kam stéká voda</span></div>`;
    }
    // Hřeben podél / napříč – u střech s hřebenem (výchozí v OSM je „podél delší strany“)
    if (ORIENTOVATELNE.includes(tags['roof:shape'])) {
      const o = tags['roof:orientation'];
      h += `<div class="bp-radek"><label>Hřeben</label>` +
        `<button type="button" class="bp-tl${o === 'along' ? ' bp-aktivni' : ''}" data-akce="hreben" data-hodnota="along">podél delší strany</button>` +
        `<button type="button" class="bp-tl${o === 'across' ? ' bp-aktivni' : ''}" data-akce="hreben" data-hodnota="across">napříč</button>` +
        `<span class="bp-klic">roof:orientation${o ? '' : ' – nezadáno = podél'}</span></div>`;
    }
    h += `</div>`;

    // Podlaží – tlačítka −/+
    h += `<div class="bp-sekce"><b>Podlaží</b>`;
    for (const p of PODLAZI) {
      if (p.jenCast && !jeCast) continue;
      const hodnota = tags[p.klic] !== undefined ? esc(tags[p.klic]) : '–';
      h += `<div class="bp-radek"><label>${p.label}</label>` +
        `<button type="button" class="bp-krok" data-akce="patro" data-klic="${p.klic}" data-krok="-1">−</button>` +
        `<b>${hodnota}</b>` +
        `<button type="button" class="bp-krok" data-akce="patro" data-klic="${p.klic}" data-krok="1">+</button>` +
        `<span class="bp-klic">${p.klic} – ${p.napoveda}</span></div>`;
    }
    h += `</div>`;

    // Barvy (vzorky + vlastní barva) a materiály (rozbalovací seznam)
    h += `<div class="bp-sekce"><b>Barvy a materiály</b>`;
    for (const [klic, label] of [['building:colour', 'Barva fasády'], ['roof:colour', 'Barva střechy']]) {
      h += `<div class="bp-radek"><label>${label}</label>`;
      for (const c of COLOURS) {
        const aktivni = tags[klic] === c.value ? ' bp-aktivni' : '';
        h += `<button type="button" class="bp-vzorek${aktivni}" title="${c.label} (${c.value})" data-akce="barva" data-klic="${klic}" data-hodnota="${c.value}"></button>`;
      }
      const vlastni = /^#[0-9a-f]{6}$/i.test(tags[klic] || '') ? tags[klic] : '#ffffff';
      h += `<input type="color" data-klic="${klic}" value="${vlastni}" title="vlastní barva">` +
        `<span class="bp-klic">${klic}${tags[klic] ? '=' + esc(tags[klic]) : ''}</span></div>`;
    }
    for (const [klic, label, seznam] of [['building:material', 'Materiál fasády', MATERIALS_BUILDING], ['roof:material', 'Materiál střechy', MATERIALS_ROOF]]) {
      const ma = tags[klic];
      let opt = `<option value="">— nezadáno —</option>`;
      for (const m of seznam) opt += `<option value="${m.value}"${ma === m.value ? ' selected' : ''}>${m.label}</option>`;
      if (ma && !seznam.some(m => m.value === ma)) opt += `<option value="${esc(ma)}" selected>${esc(ma)}</option>`; // zachovat neznámou hodnotu
      h += `<div class="bp-radek"><label>${label}</label><select data-klic="${klic}">${opt}</select><span class="bp-klic">${klic}</span></div>`;
    }
    h += htmlOkna(tags) + `</div>`;

    // Upozornění (jen informují)
    const upoz = checkWarnings(tags);
    if (upoz.length) {
      h += `<div class="bp-sekce"><b>Upozornění</b>`;
      for (const u of upoz) h += `<div class="bp-upozorneni">⚠ ${esc(u.text)} <span class="bp-klic">${u.key}</span></div>`;
      h += `</div>`;
    }

    // Věže / části budovy
    if (jeCast && !tags['roof:shape']) {
      h += `<div class="bp-sekce"><button type="button" class="bp-tl" data-akce="vez">Předvyplnit jako věž (roof:shape=pyramidal)</button></div>`;
    }
    if (jeCast) {
      h += `<div class="bp-sekce"><button type="button" class="bp-tl" data-akce="prujezd" title="doplní min_height=4 a building:min_level=1 (jen prázdné)">Část nad průjezdem</button></div>`;
    }
    h += `<details><summary>Jak udělat průjezd budovou</summary>` +
      `<ol><li>Nástrojem <b>Plocha</b> obkresli zvlášť část budovy <b>nad průjezdem</b> a zvlášť zbytek budovy – obě jako <b>Část budovy</b>.</li>` +
      `<li>U části nad průjezdem klikni na <b>Část nad průjezdem</b> (spodní hrana 4 m, od 1. patra) a nastav výšku.</li>` +
      `<li>Na silnici nebo chodník, který vede pod budovou, rozděl cestu na okrajích budovy a úseku pod ní dej <b>tunnel=building_passage</b>.</li>` +
      `<li>Obrys budovy nech celý – 3D renderery kreslí jen části, 2D mapy obrys.</li></ol></details>`;
    h += `<details class="bp-vez"><summary>Jak namapovat věž nebo jinou část budovy</summary>` +
      `<ol><li>Nástrojem <b>Plocha</b> obkresli půdorys věže (uvnitř obrysu budovy).</li>` +
      `<li>Jako typ zvol <b>Část budovy</b> (building:part).</li>` +
      `<li>V tomto panelu nastav výšku věže (height = až po špičku), střechu a případně spodní hranu (min_height), když věž nezačíná na zemi.</li>` +
      `<li>Hlavní budově nech výšku lodi – věž ji ve 3D „přeroste“ sama.</li></ol></details>`;
    return h;
  }

  // Provede změnu z panelu: přečte aktuální značky (mohly se mezitím změnit v iD),
  // přidá změnu a zapíše vše najednou → v iD vznikne jeden krok Zpět.
  // hromadne = vybráno víc prvků (řádky "klíč=*" se zachovají a iD je přeskočí).
  function zapis(changes, hromadne) {
    const tags = nactiZnacky();
    if (!tags) return;
    if (!Object.keys(changes).length) { zobrazZpravu('Není co doplnit – vše už je vyplněné.'); return; }
    zapisZnacky(applyChanges(tags, changes), hromadne);
  }

  // Reakce na kliky v panelu (jeden posluchač pro všechna tlačítka – "delegace událostí").
  function onKlik(e) {
    const kota = e.target.closest('[data-klic].bp-kota');
    if (kota) {                                                   // klik na kótu v řezu → zaměřit pole
      const pole = document.querySelector(`#budova-panel input.bp-cislo[data-klic="${kota.dataset.klic}"]`);
      if (pole) { pole.focus(); pole.select(); }
      return;
    }
    const b = e.target.closest('button[data-akce]');
    if (!b) return;
    e.preventDefault();
    const tags = nactiZnacky() || {};
    const hromadne = vyberInfo().pocet > 1;
    switch (b.dataset.akce) {
      case 'typ': zapis(predvolbaZmeny(tags, b.dataset.hodnota, hromadne), hromadne); break;
      case 'kostel': {                                            // jen otevřít návod na části
        const d = document.querySelector('#budova-panel details.bp-vez');
        if (d) { d.open = true; d.scrollIntoView({ block: 'nearest' }); }
        else zobrazZpravu('Kostel se mapuje po částech: vyber jednu budovu a otevři návod „Jak namapovat věž“.');
        break;
      }
      case 'vyska': {
        const pole = document.querySelector('#budova-panel input.bp-patro');
        const patro = Number(normalizeNumber(pole ? pole.value : ''));
        const h = patro > 0 ? vypoctiVysku(tags, patro) : null;
        if (h === null) { zobrazZpravu('Výšku nespočítám: potřebuji celé číslo podlaží, výšku patra a u šikmé střechy i výšku střechy (roof:height).'); break; }
        zapis({ height: h });
        break;
      }
      case 'smer': zapis({ 'roof:direction': b.dataset.hodnota }); break;
      case 'otoc180': {
        const z = otocO180(tags);
        if (!Object.keys(z).length) { zobrazZpravu('Nejdřív zvol směr spádu šipkou – pak ho jde otáčet.'); break; }
        zapis(z);
        break;
      }
      case 'hreben': zapis({ 'roof:orientation': b.dataset.hodnota }); break;
      case 'otoc3d': azimut3d += Number(b.dataset.krok); prekresli3d(); break;   // jen kresba, nic se nezapisuje
      case 'verny': {
        const id = b.dataset.hodnota;                                       // "w123" / "r123"
        window.open('https://beakerboy.github.io/OSMBuilding/?type=' + (id[0] === 'r' ? 'relation' : 'way') + '&id=' + id.slice(1), '_blank', 'noopener');
        break;
      }
      case 'prujezd': zapis(zmenyPrujezd(tags)); break;
      case 'strecha': zapis({ 'roof:shape': b.dataset.hodnota }); break;
      case 'barva': zapis({ [b.dataset.klic]: b.dataset.hodnota }); break;
      case 'vez': if (!tags['roof:shape']) zapis({ 'roof:shape': 'pyramidal' }); break;
      case 'patro': {
        const klic = b.dataset.klic;
        const nove = krokPodlazi(tags[klic], Number(b.dataset.krok), klic);
        if (nove === null) { zobrazZpravu('Hodnotu ' + klic + (tags[klic] !== undefined ? '=' + tags[klic] : '') + ' tlačítkem nezměním – uprav ji v poli v iD.'); break; }
        zapis({ [klic]: nove });                                  // '' = smazat značku
        break;
      }
    }
  }

  // Reakce na změnu polí (číslo po Enter/opuštění pole, barva, materiál).
  function onZmena(e) {
    const el = e.target;
    if (el.classList && el.classList.contains('bp-okna')) {        // přepínač Bez oken
      e.stopPropagation();
      const hromadne = vyberInfo().pocet > 1;
      zapis(zmenyOkna(nactiZnacky() || {}, el.checked), hromadne);
      return;
    }
    if (!el.dataset || !el.dataset.klic) return;
    e.stopPropagation();                       // nepouštět dál do iD (není to jeho pole)
    if (el.classList.contains('bp-cislo')) {
      const v = normalizeNumber(el.value);
      if (v === null) { el.classList.add('bp-chyba'); return; } // neplatné → nic nezapsat
      el.classList.remove('bp-chyba');
      zapis({ [el.dataset.klic]: v });
    } else {
      zapis({ [el.dataset.klic]: el.value });  // select: '' = smazat; color: #rrggbb
    }
  }

  let posledniKlic = null;                     // id + značky posledního vykreslení

  // Zobrazí / aktualizuje / skryje panel podle aktuálního výběru.
  function obnovPanel(info) {
    const telo = document.querySelector(SEL.teloEditoru);
    const stary = document.getElementById('budova-panel');
    const skryj = () => { if (stary) stary.remove(); posledniKlic = null; };
    if (!info.id || !telo) return skryj();
    const hromadne = info.pocet > 1;
    const ta = najdiTextarea();
    if (!ta || ta.readOnly) return skryj();    // náhled při najetí myší je jen pro čtení
    const tags = parseTagText(ta.value);
    if (!tags.building && !tags['building:part']) return skryj();
    // Jeden prvek se "*" by byl nesmysl (ručně napsaná hodnota "*") → panel nezobrazovat.
    if (!hromadne && Object.values(tags).includes('*')) return skryj();

    // 3D náhled: půdorysy z mapy iD (živě) + značky. U jedné budovy značky z panelu; u víc
    // budov uložené značky každé z nich (OSM API) + společné hodnoty z panelu (ne "*").
    const ids = info.id.split(',');
    if (hromadne) nactiUlozene(ids);
    const pudy = ids.map(nactiPudorys);
    const vidim = pudy.filter(Boolean);
    const vse = vidim.flatMap(p => p.pts);
    // posun ke společnému středu → malá čísla (přesnost) a stabilní klíč při posunu mapy
    const sx = vse.length ? (Math.min(...vse.map(p => p[0])) + Math.max(...vse.map(p => p[0]))) / 2 : 0;
    const sy = vse.length ? (Math.min(...vse.map(p => p[1])) + Math.max(...vse.map(p => p[1]))) / 2 : 0;
    const spolecne = Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== '*'));
    const modely = [], poznamky = [];
    ids.forEach((id, i) => {
      if (!pudy[i]) return;
      const pts = pudy[i].pts.map(p => [p[0] - sx, p[1] - sy]);
      const m = model3d(hromadne ? Object.assign({}, ulozene[id] || {}, spolecne) : tags, pts);
      modely.push(m);
      if (!hromadne) poznamky.push(...m.poznamky);
    });
    if (!vidim.length) poznamky.push('budova není v mapě vidět – posuň nebo oddal mapu');
    else if (vidim.length < ids.length) poznamky.push('některé vybrané budovy nejsou v mapě vidět');
    if (vidim.some(p => p.orez)) poznamky.push('budova není celá ve výřezu mapy – náhled může být useknutý');
    if (hromadne) poznamky.push('každá budova podle svých uložených hodnot + společné změny z panelu');
    const verny = !hromadne && /^[wr]\d+$/.test(info.id) ? info.id : null;     // jen uložená budova
    const geo = vse.map(p => (p[0] - sx).toFixed(1) + ',' + (p[1] - sy).toFixed(1)).join(';');

    const klic = info.id + '|' + ta.value + '|' + geo + '|' + Object.keys(ulozene).length;
    if (stary && stary.parentNode === telo && klic === posledniKlic) return; // nic se nezměnilo
    if (stary && stary.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && document.activeElement.type !== 'color') return; // uživatel právě píše

    let panel = stary;
    if (!panel || panel.parentNode !== telo) {
      if (panel) panel.remove();
      panel = document.createElement('div');
      panel.id = 'budova-panel';
      panel.addEventListener('click', onKlik);
      panel.addEventListener('change', onZmena);
      // Enter v číselném poli = potvrdit (vyvolá change přes blur)
      panel.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('bp-cislo')) e.target.blur(); });
      // Otáčení 3D náhledu tažením myši: vodorovný posun = změna azimutu (překresluje se jen kresba)
      panel.addEventListener('mousedown', e => {
        if (!e.target.closest('.bp-3d-obal')) return;
        e.preventDefault();
        const x0 = e.clientX, a0 = azimut3d;
        const pohyb = ev => { azimut3d = a0 + (ev.clientX - x0) * 0.7; prekresli3d(); };
        const konec = () => { document.removeEventListener('mousemove', pohyb); document.removeEventListener('mouseup', konec); };
        document.addEventListener('mousemove', pohyb);
        document.addEventListener('mouseup', konec);
      });
      telo.prepend(panel);
    }
    const nahled = htmlNahledu(modely, poznamky, verny);
    panel.innerHTML = hromadne ? htmlHromadne(tags, info.pocet, nahled) : htmlPanelu(tags, nahled);
    // Značka s mezerou na okraji: upozornit hned, ne až když zápis odmítne
    const duvod = duvodNezapsat(ta.value, hromadne);
    if (duvod) zobrazZpravu(duvod);
    posledniKlic = klic;
  }

  // Červená zpráva nahoře v panelu (proč se něco nezapsalo). Zmizí s dalším překreslením.
  function zobrazZpravu(text) {
    const panel = document.getElementById('budova-panel');
    if (!panel) return;
    let z = panel.querySelector('.bp-zprava');
    if (!z) { z = document.createElement('div'); z.className = 'bp-zprava'; panel.prepend(z); }
    z.textContent = '⛔ ' + text;                     // textContent = žádné HTML z dat
  }

  // Start: vložit styly a začít sledovat výběr v iD.
  // Barvy vzorků jsou pravidla CSS podle data-hodnota (inline style="…" by CSP zablokovala).
  const stylVzorku = COLOURS.map(c => `#budova-panel .bp-vzorek[data-hodnota="${c.value}"] { background: ${c.hex}; }`).join('\n');
  GM_addStyle(STYL + stylVzorku);
  sledujVyber(obnovPanel);
})();
