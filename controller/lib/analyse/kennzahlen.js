// kennzahlen.js — Kennzahlen-Bibliothek fuer die Datenanalyse-Erweiterung.
// PURE Funktionen: kein DB-Zugriff, kein nextcontrol.js-Import,
// kein Datum.now()/Math.random() -- bei gleicher Eingabe immer byte-identische Ausgabe
// (Determinismus ist hier Pflicht: "KI bekommt fertige Kennzahlen als Daten").
//
// Jede Analyse liefert dasselbe Format: { verfuegbar: boolean, grund: string|null, daten }.
// `grund` erklaert eine fehlende Datenbasis (Gating-Muster wie website/assets/statsview.js) --
// die aufrufende Seite (spaeter analysen.html) kann so einheitlich "Daten erst ab ..."
// anzeigen, ohne pro Analyse eigene Sonderfaelle zu brauchen.
//
// Season-Token ("season:Fall2020", siehe scripts/lib/saison.js) werden aus allen
// ZEITREIHEN-Analysen (Formkurven, Aufsteiger/Absteiger, Aktivitaet, Rivalitaeten,
// Anomalien) ausgeklammert -- sie sind keine echten, chronologisch einordbaren Monate.
// Fuer die nicht-chronologischen Analysen (Dominanz, Zeiteinsatz-vs-Leistung) bleiben ihre
// Records dagegen wertvolle Datenpunkte und werden mitgezaehlt.

import { berechneRanking } from '../../../scripts/lib/punkte.js';

/** Filtert Season-Token heraus und sortiert chronologisch aufsteigend ("YYYY-MM" sortiert lexikographisch korrekt). */
export function nurEchteMonateSortiert(monthlyRankingsListe) {
    return monthlyRankingsListe
        .filter((m) => /^\d{4}-\d{2}$/.test(m.monat))
        .sort((a, b) => a.monat.localeCompare(b.monat));
}

function sortiertNachPunkten(eintraege) {
    return [...eintraege].sort((a, b) => b.punkte - a.punkte);
}

function platzUndPunkteIndex(eintraege) {
    const index = new Map();
    sortiertNachPunkten(eintraege).forEach((e, i) => index.set(e.login, { platz: i + 1, punkte: e.punkte, name: e.name }));
    return index;
}

function pearsonKorrelation(xs, ys) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx, dy = ys[i] - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    if (sxx === 0 || syy === 0) return 0; // keine Streuung -> Korrelation nicht definiert
    return sxy / Math.sqrt(sxx * syy);
}

/**
 * Formkurven je Spieler: Punkte/Platz je echtem Monat + gleitender 3-Monats-Mittelwert.
 * @param {Array<{monat:string, eintraege:Array}>} echteMonateChronologisch bereits gefiltert+sortiert (nurEchteMonateSortiert)
 */
export function berechneFormkurven(echteMonateChronologisch) {
    if (echteMonateChronologisch.length === 0) {
        return { verfuegbar: false, grund: 'Noch keine archivierten Monate mit Ranking vorhanden.', daten: null };
    }

    const proSpieler = new Map(); // login -> { name, verlauf: [{monat,punkte,platz}] }
    for (const monatsDoc of echteMonateChronologisch) {
        const sortiert = sortiertNachPunkten(monatsDoc.eintraege);
        sortiert.forEach((e, i) => {
            if (!proSpieler.has(e.login)) proSpieler.set(e.login, { login: e.login, name: e.name, verlauf: [] });
            proSpieler.get(e.login).verlauf.push({ monat: monatsDoc.monat, punkte: e.punkte, platz: i + 1 });
        });
    }

    const daten = [...proSpieler.values()].map(({ login, name, verlauf }) => ({
        login,
        name,
        verlauf: verlauf.map((v, i) => {
            const fenster = verlauf.slice(Math.max(0, i - 2), i + 1); // aktueller Monat + bis zu 2 davor
            const schnitt = fenster.reduce((s, x) => s + x.punkte, 0) / fenster.length;
            return { ...v, gleitenderSchnitt3: Math.round(schnitt) };
        }),
    }));

    return { verfuegbar: true, grund: null, daten };
}

/**
 * Auf-/Absteiger zwischen zwei Ranking-Momentaufnahmen (Platz-/Punktedelta je Spieler,
 * der in BEIDEN Momentaufnahmen vorkommt -- Neueinsteiger werden nicht verglichen).
 * Cadence-neutral (wird sowohl fuer den Monats- als auch den Wochenvergleich genutzt,
 * siehe berechneMonatsKennzahlen()/berechneWochenKennzahlen()) -- die `grund`-Texte
 * duerfen deshalb keine "Monat"-Wortwahl fest verdrahten.
 * @param {{monat:string, eintraege:Array}|null} vorher
 * @param {{monat:string, eintraege:Array}|null} jetzt
 */
export function berechneAufUndAbsteiger(vorher, jetzt, mindestSpieler = 3) {
    if (!vorher || !jetzt) {
        return { verfuegbar: false, grund: 'Es muss eine vorherige und eine aktuelle Rangliste vorliegen.', daten: null };
    }
    const vorherIndex = platzUndPunkteIndex(vorher.eintraege);
    const jetztSortiert = sortiertNachPunkten(jetzt.eintraege);
    if (jetztSortiert.length < mindestSpieler || vorherIndex.size < mindestSpieler) {
        return { verfuegbar: false, grund: `Mindestens ${mindestSpieler} Spieler in beiden Ranglisten noetig.`, daten: null };
    }

    const bewegungen = jetztSortiert
        .map((e, i) => {
            const vorherEintrag = vorherIndex.get(e.login);
            if (!vorherEintrag) return null; // neu im Ranking -- kein Vergleich moeglich
            const platzJetzt = i + 1;
            return {
                login: e.login,
                name: e.name,
                platzVorher: vorherEintrag.platz,
                platzJetzt,
                platzDelta: vorherEintrag.platz - platzJetzt, // positiv = aufgestiegen
                punkteVorher: vorherEintrag.punkte,
                punkteJetzt: e.punkte,
                punkteDelta: e.punkte - vorherEintrag.punkte,
            };
        })
        .filter(Boolean);

    const aufsteiger = bewegungen.filter((b) => b.platzDelta > 0).sort((a, b) => b.platzDelta - a.platzDelta).slice(0, 5);
    const absteiger = bewegungen.filter((b) => b.platzDelta < 0).sort((a, b) => a.platzDelta - b.platzDelta).slice(0, 5);

    if (aufsteiger.length === 0 && absteiger.length === 0) {
        return { verfuegbar: false, grund: 'Keine Platzverschiebungen seit dem Vergleichszeitpunkt.', daten: null };
    }
    return { verfuegbar: true, grund: null, daten: { aufsteiger, absteiger, von: vorher.monat, bis: jetzt.monat } };
}

/** Aktivitaetstrend (Spielzeit/Verbindungen/Finishes/Checkpoints je Monat) -- nur Monate mit aktivitaetErfasst. */
export function berechneAktivitaetstrend(echteMonateChronologisch) {
    const erfasste = echteMonateChronologisch.filter((m) => m.aktivitaetErfasst && Array.isArray(m.aktivitaet));
    if (erfasste.length === 0) {
        return { verfuegbar: false, grund: 'Aktivitaetsdaten werden erst ab dem Saisonstart erfasst (siehe AKTIVITAET_SEIT_MONAT).', daten: null };
    }

    const daten = erfasste.map((m) => {
        const summe = m.aktivitaet.reduce(
            (acc, a) => ({
                timePlayed: acc.timePlayed + (a.timePlayed ?? 0),
                connections: acc.connections + (a.connections ?? 0),
                finishes: acc.finishes + (a.finishes ?? 0),
                checkpoints: acc.checkpoints + (a.checkpoints ?? 0),
            }),
            { timePlayed: 0, connections: 0, finishes: 0, checkpoints: 0 }
        );
        return { monat: m.monat, aktiveSpieler: m.aktivitaet.length, ...summe };
    });

    return { verfuegbar: true, grund: null, daten };
}

/**
 * "Hausstrecken": Maps, auf denen ein Spieler ueberdurchschnittlich oft Platz 1 belegt
 * (>=50% der Vorkommen dieser Map ueber alle Monate, mindestens 2 Siege).
 * @param {Array<{login:string, map:string, time:number, monat:string}>} alleRecordsMitMonat archivRecords + records (monat:'live')
 */
export function berechneDominanz(alleRecordsMitMonat, mindestVorkommen = 2) {
    if (alleRecordsMitMonat.length === 0) {
        return { verfuegbar: false, grund: 'Keine Records vorhanden.', daten: null };
    }

    // Ein "Vorkommen" einer Map = ein Monat, in dem sie gefahren wurde (dieselbe Map kann
    // in mehreren Monaten mit unterschiedlichen Siegern auftauchen -> je Map+Monat ein Sieger).
    const proMapUndMonat = new Map(); // "map||monat" -> Records[]
    for (const r of alleRecordsMitMonat) {
        if (!r.map || !r.login || !Number.isFinite(r.time)) continue;
        const key = `${r.map}||${r.monat ?? 'live'}`;
        if (!proMapUndMonat.has(key)) proMapUndMonat.set(key, []);
        proMapUndMonat.get(key).push(r);
    }

    const proMap = new Map(); // map -> { vorkommen, siege: Map<login,{name,anzahl}> }
    for (const [key, eintraege] of proMapUndMonat) {
        const map = key.slice(0, key.lastIndexOf('||'));
        const sieger = [...eintraege].sort((a, b) => a.time - b.time)[0];
        if (!proMap.has(map)) proMap.set(map, { vorkommen: 0, siege: new Map() });
        const eintrag = proMap.get(map);
        eintrag.vorkommen++;
        const bisher = eintrag.siege.get(sieger.login) ?? { name: sieger.name ?? sieger.login, anzahl: 0 };
        bisher.anzahl++;
        eintrag.siege.set(sieger.login, bisher);
    }

    const hausstrecken = [];
    for (const [map, { vorkommen, siege }] of proMap) {
        if (vorkommen < mindestVorkommen) continue;
        for (const [login, { name, anzahl }] of siege) {
            const anteil = anzahl / vorkommen;
            if (anzahl >= 2 && anteil >= 0.5) {
                hausstrecken.push({ map, login, name, siege: anzahl, vorkommen, anteilProzent: Math.round(anteil * 100) });
            }
        }
    }
    hausstrecken.sort((a, b) => b.anteilProzent - a.anteilProzent || b.siege - a.siege);

    if (hausstrecken.length === 0) {
        return { verfuegbar: false, grund: `Noch keine Map mit mindestens ${mindestVorkommen} Vorkommen und einem dominanten Sieger (>=50%).`, daten: null };
    }
    return { verfuegbar: true, grund: null, daten: hausstrecken };
}

/**
 * Korrelation zwischen investierter Spielzeit und erzielten Punkten, je Spieler ueber die
 * Monate mit erfasster Aktivitaet hinweg (Pearson). Ersetzt die fruehere Karma-vs-Leistung-
 * Analyse (Betreiber-Wunsch 2026-09-01: Zeiteinsatz ist eine belastbarere, fuer jeden Spieler
 * vorhandene Kennzahl statt der freiwilligen, oft nur sparsam genutzten Karma-Bewertung).
 * Positiv = wer in einem Monat mehr Zeit investiert, holt tendenziell auch mehr Punkte.
 * @param {Array<{monat:string, eintraege:Array, aktivitaetErfasst?:boolean, aktivitaet?:Array<{login:string,timePlayed:number}>}>} echteMonateChronologisch
 */
export function berechneZeiteinsatzVsLeistung(echteMonateChronologisch, mindestPaare = 3) {
    const erfasste = echteMonateChronologisch.filter((m) => m.aktivitaetErfasst && Array.isArray(m.aktivitaet));
    if (erfasste.length === 0) {
        return { verfuegbar: false, grund: 'Aktivitaetsdaten werden erst ab dem Saisonstart erfasst (siehe AKTIVITAET_SEIT_MONAT).', daten: null };
    }

    const namenIndex = new Map();
    for (const m of erfasste) for (const e of m.eintraege) namenIndex.set(e.login, e.name);

    const paareProSpieler = new Map(); // login -> [{zeit,punkte}]
    for (const m of erfasste) {
        const punkteProLogin = new Map(m.eintraege.map((e) => [e.login, e.punkte]));
        for (const a of m.aktivitaet) {
            const punkte = punkteProLogin.get(a.login);
            if (punkte === undefined || !Number.isFinite(a.timePlayed)) continue; // Aktivitaet ohne Punkte-Eintrag diesen Monat -> kein Vergleichspunkt
            if (!paareProSpieler.has(a.login)) paareProSpieler.set(a.login, []);
            paareProSpieler.get(a.login).push({ zeit: a.timePlayed, punkte });
        }
    }

    const daten = [];
    for (const [login, paare] of paareProSpieler) {
        if (paare.length < mindestPaare) continue;
        const korrelation = pearsonKorrelation(paare.map((p) => p.zeit), paare.map((p) => p.punkte));
        daten.push({ login, name: namenIndex.get(login) ?? login, stichprobe: paare.length, korrelation: Math.round(korrelation * 100) / 100 });
    }
    daten.sort((a, b) => Math.abs(b.korrelation) - Math.abs(a.korrelation));

    if (daten.length === 0) {
        return { verfuegbar: false, grund: `Noch keine Spieler mit mindestens ${mindestPaare} Monaten erfasster Aktivitaet UND Punkte-Eintrag.`, daten: null };
    }
    return { verfuegbar: true, grund: null, daten };
}

/**
 * Neu hinzugekommene Spieler im Berichtszeitraum (anhand players.firstSeen). Rein
 * datenbasiert -- KEIN Date.now() (Determinismus-Pflicht, siehe Datei-Kopfkommentar): der
 * Zeitraum ergibt sich aus dem vom Aufrufer gebauten Praedikat (Berichtsmonat bzw. letzter
 * Wochen-Snapshot-Zeitpunkt), nicht aus der aktuellen Uhrzeit -- sonst waere ein
 * spaeter/manuell nachgeholter Lauf fuer einen vergangenen Zeitraum falsch.
 * @param {Map<string,Date|string|null>} spielerFirstSeen login -> erster Verbindungszeitpunkt
 * @param {Map<string,string>} spielerNamen login -> Anzeigename
 * @param {(datum:Date) => boolean} liegtImZeitraum Praedikat, ob ein firstSeen-Datum in den Berichtszeitraum faellt
 */
export function berechneNeueSpieler(spielerFirstSeen, spielerNamen, liegtImZeitraum) {
    const neue = [];
    for (const [login, firstSeen] of spielerFirstSeen) {
        if (!firstSeen) continue;
        const datum = firstSeen instanceof Date ? firstSeen : new Date(firstSeen);
        if (Number.isNaN(datum.getTime()) || !liegtImZeitraum(datum)) continue;
        neue.push({ login, name: spielerNamen.get(login) ?? login, seit: datum.toISOString().slice(0, 10) });
    }
    neue.sort((a, b) => a.seit.localeCompare(b.seit));

    if (neue.length === 0) {
        return { verfuegbar: false, grund: 'Keine neuen Spieler im Berichtszeitraum.', daten: null };
    }
    return { verfuegbar: true, grund: null, daten: neue };
}

/** Spielerpaare mit kleinem Punktabstand (<=maxAbstand) in mindestens `mindestMonate` verschiedenen Monaten. */
export function berechneRivalitaeten(echteMonateChronologisch, maxAbstand = 300, mindestMonate = 3) {
    if (echteMonateChronologisch.length < mindestMonate) {
        return { verfuegbar: false, grund: `Mindestens ${mindestMonate} archivierte Monate noetig.`, daten: null };
    }

    const proPaar = new Map(); // "loginA||loginB" (alphabetisch) -> { nameA, nameB, monate:[{monat,abstand}] }
    for (const monatsDoc of echteMonateChronologisch) {
        const sortiert = sortiertNachPunkten(monatsDoc.eintraege);
        for (let i = 0; i < sortiert.length - 1; i++) {
            for (let j = i + 1; j < sortiert.length; j++) {
                const abstand = Math.abs(sortiert[i].punkte - sortiert[j].punkte);
                if (abstand > maxAbstand) continue;
                const [a, b] = [sortiert[i], sortiert[j]].sort((x, y) => (x.login < y.login ? -1 : 1));
                const key = `${a.login}||${b.login}`;
                if (!proPaar.has(key)) proPaar.set(key, { loginA: a.login, nameA: a.name, loginB: b.login, nameB: b.name, monate: [] });
                proPaar.get(key).monate.push({ monat: monatsDoc.monat, abstand });
            }
        }
    }

    const daten = [...proPaar.values()]
        .filter((r) => r.monate.length >= mindestMonate)
        .map((r) => ({ ...r, anzahlMonate: r.monate.length, letzterAbstand: r.monate[r.monate.length - 1].abstand }))
        .sort((a, b) => b.anzahlMonate - a.anzahlMonate || a.letzterAbstand - b.letzterAbstand)
        .slice(0, 10);

    if (daten.length === 0) {
        return { verfuegbar: false, grund: `Noch keine Spielerpaare mit Punktabstand <=${maxAbstand} in mindestens ${mindestMonate} Monaten.`, daten: null };
    }
    return { verfuegbar: true, grund: null, daten };
}

/**
 * Auffaellige Monate (z-Score der eigenen Punkte vs. eigener Historie) + Comebacks
 * (Rueckkehr nach einer Pause von mindestens `mindestPauseMonate` Monaten ohne Eintrag).
 * "Ungewoehnliche Uhrzeiten" (spielerSessions) sind bewusst NOCH NICHT Teil dieser Funktion --
 * die Datenbasis ist noch zu jung fuer eine sinnvolle Auswertung.
 * @param {{daten: Array|null}} formkurvenErgebnis Rueckgabe von berechneFormkurven()
 * @param {Array<{monat:string, eintraege:Array}>} echteMonateChronologisch
 */
export function berechneAnomalien(formkurvenErgebnis, echteMonateChronologisch, mindestHistorie = 4, mindestPauseMonate = 2) {
    const ungewoehnlicheMonate = [];
    for (const { login, name, verlauf } of formkurvenErgebnis?.daten ?? []) {
        if (verlauf.length < mindestHistorie) continue;
        const punkte = verlauf.map((v) => v.punkte);
        const mittel = punkte.reduce((a, b) => a + b, 0) / punkte.length;
        const stdAbw = Math.sqrt(punkte.reduce((a, b) => a + (b - mittel) ** 2, 0) / punkte.length);
        if (stdAbw === 0) continue; // konstante Punktzahl -> kein sinnvoller z-Score

        const letzter = verlauf[verlauf.length - 1];
        const zScore = (letzter.punkte - mittel) / stdAbw;
        if (Math.abs(zScore) >= 1.5) {
            ungewoehnlicheMonate.push({
                login, name, monat: letzter.monat, punkte: letzter.punkte,
                eigenerSchnitt: Math.round(mittel), zScore: Math.round(zScore * 100) / 100,
                art: zScore > 0 ? 'ungewoehnlich_stark' : 'ungewoehnlich_schwach',
            });
        }
    }
    ungewoehnlicheMonate.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

    const comebacks = [];
    if (echteMonateChronologisch.length >= mindestPauseMonate + 2) {
        const monateProSpieler = new Map(); // login -> Indizes der Monate mit Eintrag
        echteMonateChronologisch.forEach((m, i) => {
            for (const e of m.eintraege) {
                if (!monateProSpieler.has(e.login)) monateProSpieler.set(e.login, []);
                monateProSpieler.get(e.login).push(i);
            }
        });
        const letzterIndex = echteMonateChronologisch.length - 1;
        for (const [login, indizes] of monateProSpieler) {
            if (indizes[indizes.length - 1] !== letzterIndex) continue; // im aktuellsten Monat nicht dabei -> kein Comeback JETZT
            let groessteLuecke = 0;
            for (let i = 1; i < indizes.length; i++) groessteLuecke = Math.max(groessteLuecke, indizes[i] - indizes[i - 1] - 1);
            if (groessteLuecke >= mindestPauseMonate) {
                const name = echteMonateChronologisch[letzterIndex].eintraege.find((e) => e.login === login)?.name ?? login;
                comebacks.push({ login, name, pauseMonate: groessteLuecke, monat: echteMonateChronologisch[letzterIndex].monat });
            }
        }
        comebacks.sort((a, b) => b.pauseMonate - a.pauseMonate);
    }

    if (ungewoehnlicheMonate.length === 0 && comebacks.length === 0) {
        return { verfuegbar: false, grund: 'Noch keine Auffaelligkeiten (Ausreisser oder Comebacks) erkannt.', daten: null };
    }
    return { verfuegbar: true, grund: null, daten: { ungewoehnlicheMonate, comebacks } };
}

/** Zerlegt das Ergebnis von berechneAufUndAbsteiger() in die zwei kiAnalysen-Kennzahlen-Felder. */
function aufsteigerAbsteigerFelder(aufUndAbsteiger) {
    return {
        aufsteiger: { verfuegbar: aufUndAbsteiger.verfuegbar, grund: aufUndAbsteiger.grund, daten: aufUndAbsteiger.daten?.aufsteiger ?? null },
        absteiger: { verfuegbar: aufUndAbsteiger.verfuegbar, grund: aufUndAbsteiger.grund, daten: aufUndAbsteiger.daten?.absteiger ?? null },
    };
}

/**
 * "Diese Woche": Verbesserungen je Spieler aus den letzten Tagesberichten (Collection
 * tagesberichte, siehe telegram.js sendeTagesReport -- ein Dokument existiert nur fuer
 * Tage MIT Aktivitaet). Ersetzt die vorher hier verwendeten, aber innerhalb eines Monats
 * unveraenderten Monats-Kennzahlen durch ein Signal, das sich jede Woche tatsaechlich bewegt.
 * @param {Array<{datum:string, anzahlVerbesserungen:number, verbesserungen:Array<{name:string, anzahl:number}>}>} tagesberichteWoche
 */
export function berechneWochenAktivitaet(tagesberichteWoche) {
    if (tagesberichteWoche.length === 0) {
        return { verfuegbar: false, grund: 'Diese Woche noch keine Verbesserungen.', daten: null };
    }

    const proSpieler = new Map(); // name -> anzahl
    let gesamt = 0;
    for (const tag of tagesberichteWoche) {
        for (const v of tag.verbesserungen ?? []) {
            proSpieler.set(v.name, (proSpieler.get(v.name) ?? 0) + v.anzahl);
            gesamt += v.anzahl;
        }
    }

    const proSpielerListe = [...proSpieler.entries()]
        .map(([name, anzahl]) => ({ name, anzahl }))
        .sort((a, b) => b.anzahl - a.anzahl);

    return { verfuegbar: true, grund: null, daten: { gesamt, tage: tagesberichteWoche.length, proSpieler: proSpielerListe } };
}

/**
 * "Engste Duelle JETZT": Punktabstand zwischen in der Rangliste direkt benachbarten
 * Spielern -- anders als berechneRivalitaeten() (Monatshistorie ueber mehrere Monate
 * hinweg noetig) ist das eine reine Momentaufnahme und damit auch mitten im Monat/in der
 * Woche ein frisches Signal.
 * @param {{eintraege:Array}|null} liveRanking
 */
export function berechneNaheDuelle(liveRanking, maxAbstand = 300) {
    if (!liveRanking || liveRanking.eintraege.length < 2) {
        return { verfuegbar: false, grund: 'Noch keine Zeiten in diesem Monat gefahren.', daten: null };
    }
    const sortiert = sortiertNachPunkten(liveRanking.eintraege);
    const duelle = [];
    for (let i = 0; i < sortiert.length - 1; i++) {
        const abstand = sortiert[i].punkte - sortiert[i + 1].punkte;
        if (abstand <= maxAbstand) {
            duelle.push({
                loginA: sortiert[i].login, nameA: sortiert[i].name,
                loginB: sortiert[i + 1].login, nameB: sortiert[i + 1].name,
                abstand,
            });
        }
    }
    if (duelle.length === 0) {
        return { verfuegbar: false, grund: `Aktuell kein Duell mit Punktabstand <=${maxAbstand}.`, daten: null };
    }
    return { verfuegbar: true, grund: null, daten: duelle.slice(0, 5) };
}

/**
 * Woechentliche Kennzahlen: bewusst NUR Signale, die sich innerhalb einer
 * Woche tatsaechlich veraendern -- im Gegensatz zu den vorher hier mitgelaufenen
 * Monats-Kennzahlen (Formkurven/Aktivitaet/Dominanz/Zeiteinsatz/Rivalitaeten/Anomalien), die
 * bis zum naechsten Monatswechsel byte-identisch blieben und den woechentlichen KI-Bericht
 * faktisch wiederholten. Diese monatlichen Kennzahlen liefert jetzt stattdessen
 * berechneMonatsKennzahlen() fuer den separaten, einmal im Monat laufenden Monatsbericht.
 * @param {object} daten
 * @param {Array<{monat:string, eintraege:Array}>} daten.monthlyRankings Nur fuer den Bootstrap-
 *   Fallback (siehe unten), solange noch kein weeklySnapshot existiert.
 * @param {Array<{login:string, time:number, map:string}>} daten.records aktueller (noch nicht archivierter) Monat
 * @param {Array<{datum:string, anzahlVerbesserungen:number, verbesserungen:Array}>} daten.tagesberichteWoche
 * @param {Map<string,string>} daten.spielerNamen login -> Anzeigename
 * @param {{takenAt:Date|string, rangliste:Array}|null} [daten.wochenSnapshot] letzter Wochenrueckblick-
 *   Snapshot (siehe telegram.js sendeWochenRueckblick, Collection weeklySnapshots) -- die
 *   Aufsteiger/Absteiger-Basis fuer "die letzten ~7 Tage".
 * @param {Map<string,Date|string|null>} [daten.spielerFirstSeen] login -> erster Verbindungszeitpunkt (fuer "neue Spieler")
 */
export function berechneWochenKennzahlen({ monthlyRankings, records, tagesberichteWoche, spielerNamen, spielerFirstSeen = new Map(), wochenSnapshot = null }) {
    const liveRanking = records.length > 0 ? { monat: 'live', eintraege: berechneRanking(records, spielerNamen) } : null;

    let aufUndAbsteiger;
    if (wochenSnapshot && liveRanking) {
        aufUndAbsteiger = berechneAufUndAbsteiger({ monat: 'vorwoche', eintraege: wochenSnapshot.rangliste }, liveRanking);
    } else {
        // Bootstrap-Fallback, solange noch kein weeklySnapshot existiert (z.B. kurz nach
        // Ersteinrichtung): letzter archivierter Monat vs. laufender Monat als Behelfsbasis.
        const echteMonate = nurEchteMonateSortiert(monthlyRankings);
        const vergleichsListe = liveRanking ? [...echteMonate, liveRanking] : echteMonate;
        aufUndAbsteiger = berechneAufUndAbsteiger(
            vergleichsListe[vergleichsListe.length - 2] ?? null,
            vergleichsListe[vergleichsListe.length - 1] ?? null
        );
    }

    // "Neue Spieler": seit dem letzten Wochen-Snapshot dazugekommen. Ohne Snapshot (Bootstrap-
    // Phase) gibt es keine sinnvolle Abgrenzung "seit wann diese Woche" -- bewusst nicht verfuegbar
    // statt eines geratenen Zeitfensters.
    const neueSpieler = wochenSnapshot
        ? berechneNeueSpieler(spielerFirstSeen, spielerNamen, (datum) => datum.getTime() > new Date(wochenSnapshot.takenAt).getTime())
        : { verfuegbar: false, grund: 'Kein Wochen-Snapshot-Zeitpunkt vorhanden (Bootstrap-Phase).', daten: null };

    return {
        ...aufsteigerAbsteigerFelder(aufUndAbsteiger),
        wochenAktivitaet: berechneWochenAktivitaet(tagesberichteWoche),
        naheDuelle: berechneNaheDuelle(liveRanking),
        neueSpieler,
    };
}

/**
 * Monatliche Kennzahlen (vorher Teil von berechneAlleKennzahlen): der
 * historische Rueckblick ueber die vergangenen Monate und ihre Veraenderungen -- laeuft nur
 * einmal im Monat (siehe automatikTakt.js/analyse.js), direkt nachdem ein neuer Monat
 * archiviert wurde, und vergleicht deshalb bewusst immer zwei ARCHIVIERTE Monate.
 * @param {object} daten
 * @param {Array<{monat:string, eintraege:Array, aktivitaet?:Array, aktivitaetErfasst?:boolean}>} daten.monthlyRankings
 * @param {Array<{login:string, map:string, time:number, monat:string}>} daten.alleRecordsMitMonat archivRecords + records (monat:'live')
 * @param {Map<string,string>} daten.spielerNamen login -> Anzeigename
 * @param {Map<string,Date|string|null>} [daten.spielerFirstSeen] login -> erster Verbindungszeitpunkt (fuer "neue Spieler")
 */
export function berechneMonatsKennzahlen({ monthlyRankings, alleRecordsMitMonat, spielerNamen, spielerFirstSeen = new Map() }) {
    const echteMonate = nurEchteMonateSortiert(monthlyRankings);
    const berichtsMonat = echteMonate.length > 0 ? echteMonate[echteMonate.length - 1].monat : null;

    const formkurven = berechneFormkurven(echteMonate);
    const aufUndAbsteiger = berechneAufUndAbsteiger(echteMonate[echteMonate.length - 2] ?? null, echteMonate[echteMonate.length - 1] ?? null);

    // "Neue Spieler": firstSeen faellt in den berichteten (letzten archivierten) Monat.
    const neueSpieler = berechneNeueSpieler(spielerFirstSeen, spielerNamen, (datum) => {
        if (!berichtsMonat) return false;
        const monatToken = `${datum.getUTCFullYear()}-${String(datum.getUTCMonth() + 1).padStart(2, '0')}`;
        return monatToken === berichtsMonat;
    });

    return {
        formkurven,
        ...aufsteigerAbsteigerFelder(aufUndAbsteiger),
        aktivitaet: berechneAktivitaetstrend(echteMonate),
        dominanz: berechneDominanz(alleRecordsMitMonat),
        zeiteinsatzLeistung: berechneZeiteinsatzVsLeistung(echteMonate),
        rivalitaeten: berechneRivalitaeten(echteMonate),
        anomalien: berechneAnomalien(formkurven, echteMonate),
        neueSpieler,
    };
}
