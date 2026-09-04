// app.js -- gemeinsame Helfer fuer alle Seiten der neuen Website.

// Historische "season:..."-Monatstoken (z.B. "season:Fall2020") aus alten
// TM2020-Kampagnendateien, einmalig von scripts/migrate.js erzeugt. Nach dem
// Cutover entstehen keine neuen mehr. Identische Logik zu scripts/lib/saison.js
// und website/lib/saison.php.
const SAISON_MONAT = { Winter: '12', Spring: '03', Summer: '06', Fall: '09' };
const SAISON_NAME = { Winter: 'Winter', Spring: 'Frühling', Summer: 'Sommer', Fall: 'Herbst' };

function parseSaisonToken(monat) {
    const m = /^season:(Winter|Spring|Summer|Fall)(\d{4})$/.exec(monat);
    if (!m) return null;
    const [, saison, jahr] = m;
    return {
        sortSchluessel: `${jahr}-${SAISON_MONAT[saison]}`,
        label: `Vorsaison ${SAISON_NAME[saison]} ${jahr}`,
        kurzLabel: `${SAISON_NAME[saison]} ${jahr.slice(2)}`,
    };
}

/** Kurzes Anzeige-Label fuer Chart-Achsen/Tabellenzellen -- "07" bei "YYYY-MM", "Herbst 20" bei Season-Token. */
function monatKurzLabel(monat) {
    return parseSaisonToken(monat)?.kurzLabel ?? monat.slice(5);
}

function sanitize(s) {
    return (s || '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
}

function formatZeit(ms) {
    if (!ms && ms !== 0) return 'N/A';
    const s = ms / 1000, m = Math.floor(s / 60);
    const rest = (s % 60).toFixed(3).padStart(6, '0');
    return m ? `${m}:${rest}` : `${rest}s`;
}

/** Spielzeit in Minuten (aus playerStats.timePlayed) -> "Xh Ym" / "X Min". */
function formatSpielzeit(minuten) {
    if (!minuten) return '0 Min';
    if (minuten < 60) return `${minuten} Min`;
    const h = Math.floor(minuten / 60), m = minuten % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** "Nettes" Schrittmass fuer Achsen-Gitterlinien (ca. 4-5 Linien anstreben). */
function nettesSchrittmass(maxWert) {
    if (maxWert <= 0) return 1;
    const roh = maxWert / 4;
    const zehnerpotenz = Math.pow(10, Math.floor(Math.log10(roh)));
    const normalisiert = roh / zehnerpotenz;
    let schritt;
    if (normalisiert < 1.5) schritt = 1;
    else if (normalisiert < 3) schritt = 2;
    else if (normalisiert < 7) schritt = 5;
    else schritt = 10;
    return schritt * zehnerpotenz;
}

/**
 * Generischer, beschrifteter vertikaler Balkenchart mit Gitterlinien auf der Y-Achse.
 * @param {string} svgId
 * @param {Array<Object>} daten
 * @param {{ xKey:string, yKey:string, xLabel?:Function, farbe?:string }} cfg
 */
function zeichneBalken(svgId, daten, cfg) {
    const svg = document.getElementById(svgId);
    if (!daten.length) { svg.innerHTML = '<text x="10" y="110" class="chart-label">Keine Daten</text>'; return; }

    const breite = 700, hoehe = svg.viewBox.baseVal.height || 240;
    const randLinks = 54, randRechts = 16, randUnten = 34, randOben = 26;
    const farbe = cfg.farbe || 'var(--accent2)';
    const xLabel = cfg.xLabel || ((d) => d[cfg.xKey]);

    const maxWert = Math.max(...daten.map((d) => d[cfg.yKey]), 1);
    const schritt = nettesSchrittmass(maxWert);
    const anzahlSchritte = Math.max(1, Math.ceil(maxWert / schritt));
    const yMax = anzahlSchritte * schritt;

    const plotHoehe = hoehe - randOben - randUnten;
    const plotBreite = breite - randLinks - randRechts;
    const y = (wert) => randOben + plotHoehe - (wert / yMax) * plotHoehe;
    const breitePerBalken = plotBreite / daten.length;
    const balkenBreite = Math.min(46, breitePerBalken * 0.6);

    let inhalt = '';
    for (let i = 0; i <= anzahlSchritte; i++) {
        const wert = i * schritt;
        const yy = y(wert);
        inhalt += `<line class="chart-gitter" x1="${randLinks}" y1="${yy}" x2="${breite - randRechts}" y2="${yy}"/>`;
        inhalt += `<text class="chart-label" x="${randLinks - 10}" y="${yy + 4}" text-anchor="end">${wert.toLocaleString('de-DE')}</text>`;
    }
    inhalt += `<line class="chart-achse" x1="${randLinks}" y1="${randOben}" x2="${randLinks}" y2="${hoehe - randUnten}"/>`;

    daten.forEach((d, i) => {
        const cx = randLinks + breitePerBalken * i + breitePerBalken / 2;
        const balkenY = y(d[cfg.yKey]);
        inhalt += `<rect x="${cx - balkenBreite / 2}" y="${balkenY}" width="${balkenBreite}" height="${hoehe - randUnten - balkenY}" rx="3" fill="${farbe}" opacity="0.9"/>`;
        inhalt += `<text class="chart-label" x="${cx}" y="${hoehe - randUnten + 16}" text-anchor="middle">${sanitize(xLabel(d))}</text>`;
        inhalt += `<text class="chart-wert" x="${cx}" y="${balkenY - 6}" text-anchor="middle">${d[cfg.yKey].toLocaleString('de-DE')}</text>`;
    });
    svg.innerHTML = inhalt;
}

/** Rang-Verlauf: niedrigere Zahl = besser, daher invertierte Y-Achse mit Gitterlinien je Rang. */
function zeichneRangVerlauf(svgId, verlauf) {
    const svg = document.getElementById(svgId);
    if (!verlauf.length) { svg.innerHTML = '<text x="10" y="110" class="chart-label">Keine Daten</text>'; return; }

    const breite = 700, hoehe = 220, randLinks = 44, randRechts = 16, randUnten = 34, randOben = 20;
    const maxPlatz = Math.max(...verlauf.map((v) => v.teilnehmer || v.platz), 1);
    const plotHoehe = hoehe - randOben - randUnten;
    const plotBreite = breite - randLinks - randRechts;
    const y = (platz) => randOben + ((platz - 1) / Math.max(maxPlatz - 1, 1)) * plotHoehe;
    const schrittX = plotBreite / Math.max(verlauf.length - 1, 1);
    const x = (i) => randLinks + i * schrittX;

    // Gitterlinien je Rang (bei vielen Teilnehmern nur eine Auswahl zeigen)
    const gitterSchritt = maxPlatz <= 10 ? 1 : Math.ceil(maxPlatz / 8);
    let inhalt = '';
    for (let platz = 1; platz <= maxPlatz; platz += gitterSchritt) {
        const yy = y(platz);
        inhalt += `<line class="chart-gitter" x1="${randLinks}" y1="${yy}" x2="${breite - randRechts}" y2="${yy}"/>`;
        inhalt += `<text class="chart-label" x="${randLinks - 8}" y="${yy + 4}" text-anchor="end">#${platz}</text>`;
    }
    inhalt += `<line class="chart-achse" x1="${randLinks}" y1="${randOben}" x2="${randLinks}" y2="${hoehe - randUnten}"/>`;

    const punkte = verlauf.map((v, i) => `${x(i)},${y(v.platz)}`).join(' ');
    inhalt += `<polyline class="chart-linie" style="fill:none;stroke:var(--accent3);stroke-width:2" points="${punkte}"/>`;
    verlauf.forEach((v, i) => {
        inhalt += `<circle cx="${x(i)}" cy="${y(v.platz)}" r="4" fill="var(--accent3)"/>`;
        inhalt += `<text class="chart-wert" x="${x(i)}" y="${y(v.platz) - 10}" text-anchor="middle">#${v.platz}</text>`;
        inhalt += `<text class="chart-label" x="${x(i)}" y="${hoehe - randUnten + 18}" text-anchor="middle">${monatKurzLabel(v.monat)}</text>`;
    });
    svg.innerHTML = inhalt;
}

/**
 * Horizontaler Balkenchart (Leaderboard-Stil): Label links, Balken nach rechts.
 * Gut fuer "Top N Spieler nach Metrik X" mit langen Namens-Labels.
 * @param {string} svgId
 * @param {Array<Object>} daten (bereits in gewuenschter Reihenfolge, z.B. absteigend sortiert)
 * @param {{ labelKey:string, wertKey:string, farbe?:string, formatWert?:Function }} cfg
 */
function zeichneHorizontalBalken(svgId, daten, cfg) {
    const svg = document.getElementById(svgId);
    if (!daten.length) { svg.innerHTML = '<text x="10" y="30" class="chart-label">Keine Daten</text>'; return; }

    const breite = 700;
    const zeilenHoehe = 30, randOben = 10, randLinks = 130, randRechts = 60;
    const hoehe = randOben + daten.length * zeilenHoehe + 10;
    svg.setAttribute('viewBox', `0 0 ${breite} ${hoehe}`);
    svg.setAttribute('height', hoehe);

    const farbe = cfg.farbe || 'var(--accent2)';
    const formatWert = cfg.formatWert || ((w) => w.toLocaleString('de-DE'));
    const maxWert = Math.max(...daten.map((d) => d[cfg.wertKey]), 1);
    const plotBreite = breite - randLinks - randRechts;

    let inhalt = '';
    daten.forEach((d, i) => {
        const cy = randOben + i * zeilenHoehe + zeilenHoehe / 2;
        const balkenBreite = Math.max(2, (d[cfg.wertKey] / maxWert) * plotBreite);
        inhalt += `<text class="chart-label" x="${randLinks - 10}" y="${cy + 4}" text-anchor="end">${sanitize(d[cfg.labelKey])}</text>`;
        inhalt += `<rect x="${randLinks}" y="${cy - 9}" width="${balkenBreite}" height="18" rx="4" fill="${farbe}" opacity="0.9"/>`;
        inhalt += `<text class="chart-wert" x="${randLinks + balkenBreite + 8}" y="${cy + 4}">${formatWert(d[cfg.wertKey])}</text>`;
    });
    svg.innerHTML = inhalt;
}

/**
 * Ring-/Kreisdiagramm (Donut) mit Legende rechts. Gut fuer Anteile am Gesamtwert
 * (z.B. Spielzeit-Verteilung pro Spieler). Nutzt die stroke-dasharray-Technik.
 * @param {string} svgId
 * @param {Array<{name:string, wert:number}>} daten (bereits sortiert)
 * @param {{ formatWert?:Function }} [cfg]
 */
function zeichneKreisdiagramm(svgId, daten, cfg = {}) {
    const svg = document.getElementById(svgId);
    const gefiltert = daten.filter((d) => d.wert > 0);
    if (!gefiltert.length) { svg.innerHTML = '<text x="10" y="30" class="chart-label">Keine Daten</text>'; return; }

    const farben = ['var(--accent2)', 'var(--accent3)', 'var(--accent4)', 'var(--accent)', 'var(--gold)', 'var(--silver)', 'var(--bronze)'];
    const formatWert = cfg.formatWert || ((w) => w.toLocaleString('de-DE'));
    const summe = gefiltert.reduce((s, d) => s + d.wert, 0);

    const breite = 700, zeilenHoehe = 24;
    const cx = 120, cy = 130, r = 90, dicke = 34;
    const hoehe = Math.max(260, 30 + gefiltert.length * zeilenHoehe);
    svg.setAttribute('viewBox', `0 0 ${breite} ${hoehe}`);
    svg.setAttribute('height', hoehe);

    const umfang = 2 * Math.PI * r;
    let inhalt = '';
    let offset = 0;
    gefiltert.forEach((d, i) => {
        const anteil = d.wert / summe;
        const laenge = anteil * umfang;
        const farbe = farben[i % farben.length];
        // Kreis um -90deg gedreht, damit das erste Segment oben startet
        inhalt += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${farbe}" stroke-width="${dicke}"`
            + ` stroke-dasharray="${laenge} ${umfang - laenge}" stroke-dashoffset="${-offset}"`
            + ` transform="rotate(-90 ${cx} ${cy})" opacity="0.9"/>`;
        offset += laenge;
    });
    // Summe in der Mitte
    inhalt += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" class="chart-wert" style="font-size:15px">${formatWert(summe)}</text>`;
    inhalt += `<text x="${cx}" y="${cy + 14}" text-anchor="middle" class="chart-label">gesamt</text>`;

    // Legende rechts
    const legX = 260, legOben = 20;
    gefiltert.forEach((d, i) => {
        const y = legOben + i * zeilenHoehe;
        const farbe = farben[i % farben.length];
        const prozent = Math.round((d.wert / summe) * 100);
        inhalt += `<rect x="${legX}" y="${y}" width="12" height="12" rx="3" fill="${farbe}"/>`;
        inhalt += `<text class="chart-label" x="${legX + 20}" y="${y + 11}">${sanitize(d.name)}</text>`;
        inhalt += `<text class="chart-wert" x="${breite - 16}" y="${y + 11}" text-anchor="end">${formatWert(d.wert)} · ${prozent}%</text>`;
    });
    svg.innerHTML = inhalt;
}

/**
 * Mehrfach-Linienchart: mehrere Serien (z.B. Formkurven mehrerer Spieler) uebereinandergelegt
 * in EINEM gemeinsamen Chart, um Entwicklungen direkt vergleichen zu koennen. Serien koennen
 * unterschiedlich lange/versetzte Historien haben (z.B. spaeter dazugestossene Spieler) -- die
 * X-Achse basiert auf der uebergebenen, gemeinsamen Monatsliste (Vereinigung aller Serien),
 * fehlende Monate einer Serie werden beim Zeichnen einfach uebersprungen. Serien mit nur einem
 * bekannten Wert werden als einzelner Punkt dargestellt (eine Linie braucht mindestens zwei
 * Werte, sonst waere sie irrefuehrend). Spielernamen stehen direkt am Linienende im Chart
 * (statt nur in einer externen Legende) -- ein einfacher zweistufiger Stapel-Algorithmus
 * verschiebt eng beieinanderliegende Labels vertikal auseinander, damit sie sich nie
 * ueberlappen. Bewusst eine grosse feste Pixelbreite (kein prozentuales Skalieren) -- sonst
 * wuerde der Text auf schmalen Viewports (Mobile) mitschrumpfen und unlesbar werden; auf
 * schmalen Screens greift stattdessen wie bei allen anderen Charts der Seite .chart-wrap
 * (horizontales Scrollen).
 * @param {string} svgId
 * @param {Array<{name:string, punkte:Array<{monat:string, wert:number}>}>} serien
 * @param {{ monate:Array<string>, farben?:Array<string> }} cfg
 */
function zeichneMehrfachVerlauf(svgId, serien, cfg) {
    const svg = document.getElementById(svgId);
    if (!serien.length || !cfg.monate.length) { svg.innerHTML = '<text x="10" y="30" class="chart-label">Keine Daten</text>'; return; }

    const farben = cfg.farben || ['#4db4f5', '#e0b24a', '#6fae72', '#e08a7d', '#a78bfa', '#f472b6', '#38bdf8', '#fb923c', '#94a3b8', '#c08a54'];

    const breite = 1100, hoehe = 380, randLinks = 54, randRechts = 150, randUnten = 34, randOben = 20;
    svg.setAttribute('viewBox', `0 0 ${breite} ${hoehe}`);
    svg.setAttribute('width', breite);
    svg.setAttribute('height', hoehe);
    const plotBreite = breite - randLinks - randRechts;
    const plotHoehe = hoehe - randOben - randUnten;

    const alleWerte = serien.flatMap((s) => s.punkte.map((p) => p.wert));
    const maxWert = Math.max(...alleWerte, 1);
    const schritt = nettesSchrittmass(maxWert);
    const anzahlSchritte = Math.max(1, Math.ceil(maxWert / schritt));
    const yMax = anzahlSchritte * schritt;

    const monatIndex = new Map(cfg.monate.map((m, i) => [m, i]));
    const x = (i) => randLinks + (cfg.monate.length > 1 ? (i / (cfg.monate.length - 1)) * plotBreite : plotBreite / 2);
    const y = (wert) => randOben + plotHoehe - (wert / yMax) * plotHoehe;

    let inhalt = '';
    for (let i = 0; i <= anzahlSchritte; i++) {
        const wert = i * schritt;
        const yy = y(wert);
        inhalt += `<line class="chart-gitter" x1="${randLinks}" y1="${yy}" x2="${breite - randRechts}" y2="${yy}"/>`;
        inhalt += `<text class="chart-label" x="${randLinks - 10}" y="${yy + 4}" text-anchor="end">${wert.toLocaleString('de-DE')}</text>`;
    }
    inhalt += `<line class="chart-achse" x1="${randLinks}" y1="${randOben}" x2="${randLinks}" y2="${hoehe - randUnten}"/>`;

    // Bei vielen Monaten nur eine Auswahl an X-Labels zeigen, letzter Monat immer dabei.
    const labelSchritt = cfg.monate.length <= 10 ? 1 : Math.ceil(cfg.monate.length / 10);
    cfg.monate.forEach((m, i) => {
        if (i % labelSchritt !== 0 && i !== cfg.monate.length - 1) return;
        inhalt += `<text class="chart-label" x="${x(i)}" y="${hoehe - randUnten + 18}" text-anchor="middle">${sanitize(monatKurzLabel(m))}</text>`;
    });

    const namensLabels = [];
    serien.forEach((serie, si) => {
        const farbe = farben[si % farben.length];
        const bekanntePunkte = serie.punkte.filter((p) => monatIndex.has(p.monat));
        if (!bekanntePunkte.length) return;
        const letzter = bekanntePunkte[bekanntePunkte.length - 1];
        const lx = x(monatIndex.get(letzter.monat)), ly = y(letzter.wert);

        if (bekanntePunkte.length === 1) {
            inhalt += `<circle cx="${lx}" cy="${ly}" r="5.5" fill="${farbe}" stroke="var(--bg-card)" stroke-width="1.5"/>`;
        } else {
            const linie = bekanntePunkte.map((p) => `${x(monatIndex.get(p.monat))},${y(p.wert)}`).join(' ');
            inhalt += `<polyline points="${linie}" fill="none" stroke="${farbe}" stroke-width="2.5" opacity="0.9"/>`;
            inhalt += `<circle cx="${lx}" cy="${ly}" r="4.5" fill="${farbe}" stroke="var(--bg-card)" stroke-width="1.5"/>`;
        }

        namensLabels.push({ name: serie.name, farbe, x: lx, y: ly });
    });

    // Namens-Labels vertikal entzerren, damit sich nahe beieinanderliegende Werte nicht
    // ueberlappen: zuerst von oben nach unten mit Mindestabstand auseinanderdruecken, dann
    // von unten nach oben gegenpruefen (sonst wuerde die erste Passage alles nur nach unten
    // wegschieben und ggf. unten aus dem Plotbereich herauslaufen).
    const mindestAbstand = 16;
    namensLabels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < namensLabels.length; i++) {
        if (namensLabels[i].y < namensLabels[i - 1].y + mindestAbstand) {
            namensLabels[i].y = namensLabels[i - 1].y + mindestAbstand;
        }
    }
    for (let i = namensLabels.length - 2; i >= 0; i--) {
        if (namensLabels[i].y > namensLabels[i + 1].y - mindestAbstand) {
            namensLabels[i].y = namensLabels[i + 1].y - mindestAbstand;
        }
    }
    namensLabels.forEach((l) => {
        inhalt += `<text class="chart-label" x="${l.x + 9}" y="${l.y + 4}" style="fill:${l.farbe};font-weight:700">${sanitize(l.name)}</text>`;
    });

    svg.innerHTML = inhalt;
}

function setConnectionStatus(ok, elDotSel = '.status-dot', elTextSel = '#connection-status', offlineText = 'Verbindung unterbrochen') {
    const dot = document.querySelector(elDotSel);
    const txt = document.querySelector(elTextSel);
    if (dot) dot.style.background = ok ? '#6fae72' : '#c96b5e';
    if (txt) txt.textContent = ok ? 'Verbunden – Live Updates aktiv' : offlineText;
}

async function ladeApi(action, params = {}) {
    const qs = new URLSearchParams({ action, ...params }).toString();
    const res = await fetch(`api.php?${qs}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
}

// Ergaenzt setConnectionStatus(): auch wenn die Seite selbst erfolgreich geladen hat
// (Apache/Mongo erreichbar), kann der Trackmania-Server/-Controller trotzdem down sein --
// api.php?action=live liefert dafuer "aktuell" (Frische des serverStatus-Snapshots aus
// controller/plugins/liveStatus.js). Ohne diese Zusatzpruefung wuerde der Header
// "Verbunden – Live Updates aktiv" zeigen, obwohl der Server/Controller nicht laeuft.
async function pruefeServerErreichbarkeit() {
    try {
        const status = await ladeApi('live');
        if (status.aktuell === false) {
            setConnectionStatus(false, undefined, undefined, 'Server/Controller nicht erreichbar');
        }
    } catch {
        // Eigener Seiten-Fetch hat ja bereits geklappt (sonst waeren wir nicht hier) --
        // ein Fehler hier ist kein Grund, den bereits gesetzten Status zu verwerfen.
    }
}

function rangKlasse(index) {
    return index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : '';
}

function spielerLink(id, name) {
    return `<a href="spieler.html?id=${encodeURIComponent(id)}">${sanitize(name)}</a>`;
}

// Schwebe-Buttons (Handout + Spenden) dezent rechts unten -- zentral hier statt in jeder
// Seite dupliziert, damit Link/Text/Styling an einer Stelle pflegbar bleiben (siehe theme.css
// fuer .schwebe-buttons/.schwebe-btn). Auf handout.html selbst faellt der Handout-Button weg
// (waere ein Link auf die eigene Seite), der Spenden-Button bleibt ueberall stehen.
(function () {
    const aufHandoutSeite = /handout\.html$/.test(location.pathname);
    const wrap = document.createElement('div');
    wrap.className = 'schwebe-buttons';
    wrap.innerHTML = `
        ${aufHandoutSeite ? '' : '<a class="schwebe-btn handout" href="handout.html" title="Spieler-Handout: Befehle, Punkte-System, Abzeichen"><span class="icon">📋</span>Handout</a>'}
        <a class="schwebe-btn spenden" href="https://www.paypal.com/paypalme/Guido686" target="_blank" rel="noopener" title="Serverkosten unterstützen -- über PayPal"><span class="icon">☕</span>Spenden</a>`;
    document.body.appendChild(wrap);
})();

// Wartungsbanner: pollt api.php?action=wartungsstatus und zeigt bei aktivem
// Wartungsmodus (controller/plugins/monatswechselAutomatik.js, fehlgeschlagener
// automatischer Monatswechsel) einen sticky Hinweis oben auf jeder Seite. Eigenes,
// unabhaengiges Poll-Intervall (30s reicht -- der Zustand aendert sich nicht oft),
// bewusst getrennt von pruefeServerErreichbarkeit()/action=live.
(function () {
    const banner = document.createElement('div');
    banner.className = 'wartungs-banner';
    document.body.insertBefore(banner, document.body.firstChild);

    async function aktualisiere() {
        try {
            const status = await ladeApi('wartungsstatus');
            if (status.wartungsmodus) {
                banner.innerHTML = `<strong>🔧 Wartungsmodus:</strong> ${sanitize(status.grund || 'Der automatische Monatswechsel benötigt manuelle Prüfung.')} — der Spielbetrieb läuft normal weiter.`;
                banner.classList.add('sichtbar');
            } else {
                banner.classList.remove('sichtbar');
            }
        } catch {
            // Stiller Fehlschlag -- ein nicht erreichbares Banner ist kein Grund,
            // den Rest der Seite zu stoeren (gleiche Haltung wie pruefeServerErreichbarkeit()).
        }
    }

    aktualisiere();
    setInterval(aktualisiere, 30000);
})();
