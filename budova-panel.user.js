// ==UserScript==
// @name         iD – panel Budova (střechy, výšky, podlaží)
// @namespace    osm-edit-budovy
// @version      1.1.1
// @author       MartinSimco
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/MartinSimco/iD-budova-panel
// @supportURL   https://github.com/MartinSimco/iD-budova-panel/issues
// (updateURL/downloadURL: Tampermonkey odtud sám stahuje nové verze)
// @updateURL    https://raw.githubusercontent.com/MartinSimco/iD-budova-panel/main/budova-panel.user.js
// @downloadURL  https://raw.githubusercontent.com/MartinSimco/iD-budova-panel/main/budova-panel.user.js
// @description  Vizuální panel pro 3D atributy budov v editoru iD na openstreetmap.org: boční řez s kótami, výběr tvaru střechy obrázky, podlaží, barvy, materiály a upozornění.
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

  // Kontrola PŘED zápisem: vrátí důvod, proč panel nesmí zapsat, nebo null.
  // Panel přepisuje celý text značek, takže cokoliv, co by se při převodu změnilo,
  // by změnil i bez vědomí uživatele:
  //  - mezera na okraji klíče/hodnoty: parser ji ořízne → potichu by "opravil" i značku,
  //    na kterou uživatel nesáhl (iD ořezává stejně, takže se to nedá obejít);
  //  - hodnota "*": iD tak ukazuje smíšené hodnoty při výběru více prvků → zápis by
  //    všem vybraným prvkům přepsal skutečné hodnoty (zjištěno revizí 2026-11-23).
  function duvodNezapsat(text) {
    for (const radek of String(text).split('\n')) {
      if (!radek.trim()) continue;                      // prázdné řádky nevadí
      const i = radek.indexOf('=');
      const klic = i < 0 ? radek : radek.slice(0, i);
      const hodnota = i < 0 ? '' : radek.slice(i + 1);
      if (klic !== klic.trim() || hodnota !== hodnota.trim()) {
        return 'Značka „' + radek.trim() + '“ má mezeru na začátku nebo konci. Panel by ji při zápisu změnil, proto nic nezapíše – oprav ji nejdřív v iD.';
      }
      if (hodnota === '*') {
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
  const API = { ROOF_SHAPES, MATERIALS_BUILDING, MATERIALS_ROOF, COLOURS, parseTagText, serializeTags, applyChanges, normalizeNumber, checkWarnings, svgRez, obrysStrechy, duvodNezapsat, krokPodlazi };
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
  function zapisZnacky(noveTags) {
    const ta = najdiTextarea();
    if (!ta) return false;
    const duvod = duvodNezapsat(ta.value);           // pojistka proti nechtěné změně jiných značek
    if (duvod) { zobrazZpravu(duvod); return false; }
    ta.value = serializeTags(noveTags);
    ta.dispatchEvent(new Event('change'));            // na "change" iD reaguje funkcí textChanged
    return true;
  }

  // ID vybraného prvku z adresy (iD tam píše např. "id=w357664858").
  // Při výběru více prvků je tam "id=w1,w2" → vracíme null (hodnoty by se míchaly).
  function vybranaId() {
    const m = location.hash.match(/[#&]id=([^&]*)/);
    if (!m) return null;
    const id = decodeURIComponent(m[1]);
    return id && !id.includes(',') ? id : null;
  }

  // Volá callback(id), kdykoliv se v bočním panelu něco změní (výběr, přerenderování,
  // úprava značek). Změna hodnoty textového pole není změna DOM, proto posloucháme
  // i události input/change. Debounce 150 ms: iD při překreslení mění DOM mnohokrát
  // za sebou, stačí nám zareagovat jednou, až se uklidní.
  function sledujVyber(callback) {
    let casovac = null;
    const naplanuj = () => { clearTimeout(casovac); casovac = setTimeout(() => callback(vybranaId()), 150); };
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
    { klic: 'building:min_level', label: 'Začíná od podlaží', napoveda: 'jen u částí budovy', jenCast: true }
  ];

  // Jedno ikonové tlačítko tvaru střechy (malé SVG se stejným obrysem jako v řezu).
  function ikonaStrechy(tvar) {
    return `<svg viewBox="0 0 60 36"><rect x="10" y="22" width="40" height="12" fill="#e6e1d6" stroke="#444"/>` +
      `<path d="${obrysStrechy(tvar, 10, 50, 22, 4)}" fill="#a5684a" stroke="#444" stroke-width="${tvar === 'flat' ? 3 : 1}"/></svg>`;
  }

  // Sestaví HTML celého panelu z aktuálních značek. Nic nezapisuje – jen kreslí.
  function htmlPanelu(tags) {
    const jeCast = tags['building:part'] !== undefined;
    const nazev = tags.name ? ' – ' + esc(tags.name) : '';
    let h = `<h3>🏠 ${jeCast ? 'Část budovy' : 'Budova'}${nazev}</h3>`;

    // Boční řez + pole výšek (klik na kótu v řezu zaměří odpovídající pole)
    h += svgRez(tags);
    h += `<div class="bp-sekce"><b>Výšky</b>`;
    for (const v of VYSKY) {
      if (v.klic === 'min_height' && !jeCast && tags.min_height === undefined) continue; // u celé budovy obvykle nedává smysl
      h += `<div class="bp-radek"><label>${v.label}</label>` +
        `<input class="bp-cislo" data-klic="${v.klic}" value="${esc(tags[v.klic] || '')}" placeholder="?"> m ` +
        `<span class="bp-klic">${v.klic} – ${v.napoveda}</span></div>`;
    }
    h += `</div>`;

    // Tvar střechy – mřížka obrázkových tlačítek
    h += `<div class="bp-sekce"><b>Tvar střechy</b> <span class="bp-klic">roof:shape</span><div class="bp-strechy">`;
    for (const r of ROOF_SHAPES) {
      const aktivni = tags['roof:shape'] === r.value ? ' bp-aktivni' : '';
      h += `<button type="button" class="${aktivni}" data-akce="strecha" data-hodnota="${r.value}" title="roof:shape=${r.value}">${ikonaStrechy(r.value)}${r.label}</button>`;
    }
    h += `</div></div>`;

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
    h += `</div>`;

    // Upozornění (jen informují)
    const upoz = checkWarnings(tags);
    if (upoz.length) {
      h += `<div class="bp-sekce"><b>Upozornění</b>`;
      for (const u of upoz) h += `<div class="bp-upozorneni">⚠ ${esc(u.text)} <span class="bp-klic">${u.key}</span></div>`;
      h += `</div>`;
    }

    // Věže / části budovy
    if (jeCast && !tags['roof:shape']) {
      h += `<div class="bp-sekce"><button type="button" data-akce="vez">Předvyplnit jako věž (roof:shape=pyramidal)</button></div>`;
    }
    h += `<details><summary>Jak namapovat věž nebo jinou část budovy</summary>` +
      `<ol><li>Nástrojem <b>Plocha</b> obkresli půdorys věže (uvnitř obrysu budovy).</li>` +
      `<li>Jako typ zvol <b>Část budovy</b> (building:part).</li>` +
      `<li>V tomto panelu nastav výšku věže (height = až po špičku), střechu a případně spodní hranu (min_height), když věž nezačíná na zemi.</li>` +
      `<li>Hlavní budově nech výšku lodi – věž ji ve 3D „přeroste“ sama.</li></ol></details>`;
    return h;
  }

  // Provede změnu z panelu: přečte aktuální značky (mohly se mezitím změnit v iD),
  // přidá změnu a zapíše vše najednou → v iD vznikne jeden krok Zpět.
  function zapis(changes) {
    const tags = nactiZnacky();
    if (!tags) return;
    zapisZnacky(applyChanges(tags, changes));
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
    switch (b.dataset.akce) {
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
  function obnovPanel(id) {
    const telo = document.querySelector(SEL.teloEditoru);
    const stary = document.getElementById('budova-panel');
    const skryj = () => { if (stary) stary.remove(); posledniKlic = null; };
    if (!id || !telo) return skryj();
    const ta = najdiTextarea();
    if (!ta || ta.readOnly) return skryj();    // náhled při najetí myší je jen pro čtení
    const tags = parseTagText(ta.value);
    if (!tags.building && !tags['building:part']) return skryj();
    if (Object.values(tags).includes('*')) return skryj(); // výběr více prvků se smíšenými hodnotami

    const klic = id + '|' + ta.value;
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
      telo.prepend(panel);
    }
    panel.innerHTML = htmlPanelu(tags);
    // Značka s mezerou na okraji: upozornit hned, ne až když zápis odmítne
    const duvod = duvodNezapsat(ta.value);
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
