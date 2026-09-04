// statsview.js -- Gemeinsames Render-Modul fuer die Spielerstats-Ansicht.
// Genutzt von spielerstats.html (laufender Monat), monatsarchiv.html,
// jahresarchiv.html und halloffame.html -- gleiche Struktur, nur andere
// Zeitraeume. Erwartet, dass app.js vorher geladen ist (Chart-Helfer,
// Formatter, spielerLink, rangKlasse, sanitize).
//
// Die Seiten liefern normalisierte Eintraege:
//   { id, name, punkte, siege, mapsGespielt, mapsGefahren?,
//     timePlayed?, finishes?, checkpoints?, connections? }
// Bei aktivitaetErfasst=false (Zeitraum vor Einfuehrung der Zaehler,
// siehe monatswechsel.js/AKTIVITAET_SEIT_MONAT) zeigen alle
// Aktivitaets-Elemente den Hinweis "Vor den Aufzeichnungen".
//
// Alle Renderer greifen auf feste Element-IDs zu und ueberspringen still,
// was auf der jeweiligen Seite nicht existiert (z.B. keine Streckenmatrix
// im Jahresarchiv).

const StatsView = (() => {
    const OHNE_DATEN_TEXT = 'Vor den Aufzeichnungen';
    const AKTIVITAETS_SPALTEN = ['timePlayed', 'finishes', 'checkpoints', 'connections'];

    let eintraege = [];
    let weitereAktive = [];
    let maps = [];
    let aktivitaetErfasst = true;
    let hinweisText = '';
    let sortSpalte = 'punkte';
    let sortAufsteigend = false;

    function setzeDaten(daten) {
        eintraege = daten.eintraege ?? [];
        weitereAktive = daten.weitereAktive ?? [];
        maps = daten.maps ?? [];
        aktivitaetErfasst = daten.aktivitaetErfasst !== false;
        hinweisText = daten.hinweisText ?? '';
        // Sortierung auf Aktivitaets-Spalte zuruecksetzen, wenn der neue
        // Zeitraum keine Aktivitaetsdaten hat
        if (!aktivitaetErfasst && AKTIVITAETS_SPALTEN.includes(sortSpalte)) {
            sortSpalte = 'punkte';
            sortAufsteigend = false;
        }
        rendern();
    }

    function rendern() {
        renderBanner();
        renderKarten();
        renderTabelle();
        renderCharts();
        renderMatrix();
        renderWeitereAktive();
    }

    function sortiereNach(spalte) {
        if (!aktivitaetErfasst && AKTIVITAETS_SPALTEN.includes(spalte)) return;
        sortAufsteigend = (sortSpalte === spalte) ? !sortAufsteigend : false;
        sortSpalte = spalte;
        renderTabelle();
    }

    // -- Bausteine -----------------------------------------------------------

    function renderBanner() {
        const banner = document.getElementById('hinweis-banner');
        if (!banner) return;
        banner.innerHTML = hinweisText;
        banner.classList.toggle('sichtbar', hinweisText !== '');
    }

    function setKarte(id, text, fehlt = false) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('wert-fehlt', fehlt);
    }

    function renderKarten() {
        const summe = (liste, feld) => liste.reduce((s, p) => s + (p[feld] ?? 0), 0);
        setKarte('s-players', String(eintraege.length + (aktivitaetErfasst ? weitereAktive.length : 0)));
        setKarte('s-punkte', summe(eintraege, 'punkte').toLocaleString('de-DE'));
        setKarte('s-wins', summe(eintraege, 'siege').toLocaleString('de-DE'));
        if (aktivitaetErfasst) {
            // Aktivitaets-Summen inkl. Spieler ohne gefahrene Zeit
            const alle = eintraege.concat(weitereAktive);
            setKarte('s-time', formatSpielzeit(summe(alle, 'timePlayed')));
            setKarte('s-finishes', summe(alle, 'finishes').toLocaleString('de-DE'));
            setKarte('s-checkpoints', summe(alle, 'checkpoints').toLocaleString('de-DE'));
            setKarte('s-connections', summe(alle, 'connections').toLocaleString('de-DE'));
        } else {
            for (const id of ['s-time', 's-finishes', 's-checkpoints', 's-connections']) {
                setKarte(id, OHNE_DATEN_TEXT, true);
            }
        }
    }

    function renderTabelle() {
        const tbody = document.getElementById('tabelle-body');
        if (!tbody) return;

        document.querySelectorAll('th.sortierbar').forEach((th) => {
            th.classList.toggle('aktiv', th.dataset.key === sortSpalte);
            th.classList.toggle('deaktiviert', !aktivitaetErfasst && AKTIVITAETS_SPALTEN.includes(th.dataset.key));
        });

        const suchfeld = document.getElementById('suche');
        const suchbegriff = (suchfeld?.value ?? '').trim().toLowerCase();
        const gefiltert = eintraege.filter((s) => s.name.toLowerCase().includes(suchbegriff));
        gefiltert.sort((a, b) => sortAufsteigend
            ? (a[sortSpalte] ?? 0) - (b[sortSpalte] ?? 0)
            : (b[sortSpalte] ?? 0) - (a[sortSpalte] ?? 0));

        const aktZelle = (wert, format) => aktivitaetErfasst
            ? format(wert ?? 0)
            : `<span class="wert-fehlt" title="${OHNE_DATEN_TEXT}">—</span>`;

        tbody.innerHTML = gefiltert.length ? gefiltert.map((s, i) => `
            <tr>
                <td class="rank ${rangKlasse(i)}">#${i + 1}</td>
                <td class="player-name">${spielerLink(s.id, s.name)}</td>
                <td class="points">${s.punkte.toLocaleString('de-DE')}</td>
                <td class="wins-cell">${s.siege}</td>
                <td>${s.mapsGespielt}</td>
                <td class="time-cell">${aktZelle(s.timePlayed, formatSpielzeit)}</td>
                <td>${aktZelle(s.finishes, (w) => w.toLocaleString('de-DE'))}</td>
                <td>${aktZelle(s.checkpoints, (w) => w.toLocaleString('de-DE'))}</td>
                <td>${aktZelle(s.connections, (w) => w.toLocaleString('de-DE'))}</td>
            </tr>`).join('')
            : '<tr><td colspan="9" class="no-records">Keine Spieler gefunden</td></tr>';
    }

    function chartHinweis(svgId) {
        const svg = document.getElementById(svgId);
        if (!svg) return;
        svg.setAttribute('height', 60);
        svg.innerHTML = `<text x="10" y="34" class="chart-label">${OHNE_DATEN_TEXT} — keine Daten fuer diesen Zeitraum</text>`;
    }

    function renderCharts() {
        if (!document.getElementById('chart-punkte')) return;
        const top = (liste, feld) => [...liste].sort((a, b) => (b[feld] ?? 0) - (a[feld] ?? 0))
            .filter((p) => (p[feld] ?? 0) > 0).slice(0, 10)
            .map((p) => ({ name: p.name, wert: p[feld] }));

        zeichneHorizontalBalken('chart-punkte', top(eintraege, 'punkte'), { labelKey: 'name', wertKey: 'wert', farbe: 'var(--accent)' });
        zeichneHorizontalBalken('chart-siege', top(eintraege, 'siege'), { labelKey: 'name', wertKey: 'wert', farbe: 'var(--gold)' });

        if (aktivitaetErfasst) {
            const alle = eintraege.concat(weitereAktive);
            // Spielzeit als Kreisdiagramm (Anteil pro Spieler an der Gesamt-Spielzeit)
            zeichneKreisdiagramm('chart-zeit', top(alle, 'timePlayed'), { formatWert: formatSpielzeit });
            zeichneHorizontalBalken('chart-finishes', top(alle, 'finishes'), { labelKey: 'name', wertKey: 'wert', farbe: 'var(--accent4)' });
            zeichneHorizontalBalken('chart-checkpoints', top(alle, 'checkpoints'), { labelKey: 'name', wertKey: 'wert', farbe: 'var(--accent2)' });
            zeichneHorizontalBalken('chart-connections', top(alle, 'connections'), { labelKey: 'name', wertKey: 'wert', farbe: 'var(--accent3)' });
        } else {
            for (const id of ['chart-zeit', 'chart-finishes', 'chart-checkpoints', 'chart-connections']) chartHinweis(id);
        }
    }

    function renderMatrix() {
        const kopf = document.getElementById('checkliste-kopf');
        const body = document.getElementById('checkliste-body');
        if (!kopf || !body) return;

        const hatStreckendaten = maps.length > 0 && eintraege.some((e) => Array.isArray(e.mapsGefahren));
        if (!hatStreckendaten) {
            kopf.innerHTML = '<th class="spieler-spalte">Spieler</th>';
            body.innerHTML = `<tr><td class="no-records">Für diesen Zeitraum liegen keine Streckendaten vor (${OHNE_DATEN_TEXT}).</td></tr>`;
            return;
        }

        kopf.innerHTML = '<th class="spieler-spalte">Spieler</th>'
            + maps.map((m) => `<th class="map-spalte" title="${sanitize(m.name)}">${sanitize(m.name)}</th>`).join('')
            + '<th>Fortschritt</th>';

        if (!eintraege.length) {
            body.innerHTML = `<tr><td colspan="${maps.length + 2}" class="no-records">Noch keine Daten</td></tr>`;
            return;
        }
        const sortiert = [...eintraege].sort((a, b) => b.mapsGespielt - a.mapsGespielt);
        body.innerHTML = sortiert.map((s) => {
            const gefahrene = s.mapsGefahren ?? [];
            const zellen = maps.map((m) => {
                const gefahren = gefahrene.includes(m.uid);
                return `<td class="${gefahren ? 'haken-ja' : 'haken-nein'}">${gefahren ? '✓' : '–'}</td>`;
            }).join('');
            return `<tr>
                <td class="spieler-spalte player-name">${spielerLink(s.id, s.name)}</td>
                ${zellen}
                <td class="fortschritt-zelle">${s.mapsGespielt}/${maps.length}</td>
            </tr>`;
        }).join('');
    }

    function renderWeitereAktive() {
        const sektion = document.getElementById('weitere-aktive-sektion');
        const body = document.getElementById('weitere-aktive-body');
        if (!sektion || !body) return;
        const zeigen = aktivitaetErfasst && weitereAktive.length > 0;
        sektion.style.display = zeigen ? '' : 'none';
        if (!zeigen) return;
        body.innerHTML = weitereAktive.map((s) => `
            <tr>
                <td class="player-name">${spielerLink(s.id, s.name)}</td>
                <td class="time-cell">${formatSpielzeit(s.timePlayed ?? 0)}</td>
                <td>${(s.finishes ?? 0).toLocaleString('de-DE')}</td>
                <td>${(s.checkpoints ?? 0).toLocaleString('de-DE')}</td>
                <td>${(s.connections ?? 0).toLocaleString('de-DE')}</td>
            </tr>`).join('');
    }

    return { setzeDaten, rendern, sortiereNach };
})();

// -- Zeitleiste (Archiv-Navigation) ------------------------------------------

/** "2026-08" -> "Aug 26"; Season-Token ("season:Fall2020") -> "Herbst 20" (parseSaisonToken aus app.js). */
function monatsChipLabel(monat) {
    const m = /^(\d{4})-(\d{2})$/.exec(monat);
    if (!m) return parseSaisonToken(monat)?.kurzLabel ?? monat;
    const namen = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    return `${namen[Number(m[2]) - 1] ?? m[2]} ${m[1].slice(2)}`;
}

/**
 * Eine Chip-Zeile (z.B. Jahres-Auswahl im Jahresarchiv).
 * @param {HTMLElement} container
 * @param {Array<{key:string, label:string}>} chips
 * @param {string} aktiverKey
 * @param {(key:string)=>void} onKlick
 */
function renderChipZeile(container, chips, aktiverKey, onKlick) {
    container.innerHTML = '';
    for (const chip of chips) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'zeitleiste-chip' + (chip.key === aktiverKey ? ' aktiv' : '');
        btn.setAttribute('aria-pressed', chip.key === aktiverKey ? 'true' : 'false');
        btn.textContent = chip.label;
        btn.addEventListener('click', () => onKlick(chip.key));
        container.appendChild(btn);
    }
}

/**
 * Zweistufige Zeitleiste fuers Monatsarchiv: oben die Zyklusjahre, darunter
 * die (max. 12) Monats-Chips des gewaehlten Jahres. Klick auf ein Jahr
 * springt auf dessen neuesten Monat.
 * @param {string} containerId
 * @param {Array<{jahr:string, chips:Array<{key:string,label:string}>}>} gruppen (chronologisch aufsteigend)
 * @param {string} aktiverKey aktuell gewaehlter Monats-Key
 * @param {(key:string)=>void} onWechsel
 */
function renderZeitleiste(containerId, gruppen, aktiverKey, onWechsel) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const aktiveGruppe = gruppen.find((g) => g.chips.some((c) => c.key === aktiverKey)) ?? gruppen[gruppen.length - 1];
    container.innerHTML = '';
    if (!aktiveGruppe) return;

    // Jahres-Reihe immer anzeigen (auch bei nur einem Jahr) -- "erst Jahr, dann
    // Monat" ist die feste Bedienlogik, und ein zweites Jahr kommt ohnehin mit
    // dem naechsten Monatswechsel dazu.
    const gruppenZeile = document.createElement('div');
    gruppenZeile.className = 'zeitleiste zeitleiste-gruppen';
    container.appendChild(gruppenZeile);
    renderChipZeile(
        gruppenZeile,
        gruppen.map((g) => ({ key: g.jahr, label: g.jahr })),
        aktiveGruppe.jahr,
        (jahr) => {
            const gruppe = gruppen.find((g) => g.jahr === jahr);
            if (gruppe) onWechsel(gruppe.chips[gruppe.chips.length - 1].key);
        }
    );

    const monatsZeile = document.createElement('div');
    monatsZeile.className = 'zeitleiste';
    container.appendChild(monatsZeile);
    renderChipZeile(monatsZeile, aktiveGruppe.chips, aktiverKey, onWechsel);
}
