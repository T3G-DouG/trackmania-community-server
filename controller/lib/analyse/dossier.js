// dossier.js — AP15g: baut ein deterministisches Spieler-Dossier (Collection `spielerDossiers`)
// aus den bereits vorhandenen Analyse-Rohdaten (datenLaden.js) + firstSeen (AP15a). PURE (kein
// DB-Zugriff, kein Date.now()/Math.random(), Muster wie kennzahlen.js/guards.js) -- deshalb OHNE
// `aktualisiertAm`, das setzt der Aufrufer (dossierRefresh.js) beim Schreiben. KEINE KI-Aufrufe --
// reine deterministische Zusammenfassung bestehender kennzahlen.js-Analysen fuer EINEN Spieler.
// Dient als Kontext-Grundlage fuer die menschlichere Rennleitung (AP15h, dossierKontext.js).

import {
    nurEchteMonateSortiert,
    berechneFormkurven,
    berechneDominanz,
    berechneRivalitaeten,
    berechneAnomalien,
} from './kennzahlen.js';

/**
 * @param {string} login
 * @param {{monthlyRankings:Array, alleRecordsMitMonat:Array, karmaEintraege:Array, spielerNamen:Map<string,string>, spielerFirstSeen?:Map<string,Date|null>}} daten Rueckgabe von ladeAnalyseDaten()
 * @returns {{login:string, name:string, firstSeen:Date|null, besteSaison:{monat:string,punkte:number,platz:number}|null, aktuelleForm:Array, persoenlicheBests:object, kopfAnKopf:Array, dominanteMaps:Array<string>, karmaSchnitt:number|null, comebackNachMonaten:number|null}}
 */
export function baueDossier(login, daten) {
    const { monthlyRankings, alleRecordsMitMonat, karmaEintraege, spielerNamen, spielerFirstSeen } = daten;
    const echteMonate = nurEchteMonateSortiert(monthlyRankings);

    const formkurvenAlle = berechneFormkurven(echteMonate);
    const eigenerVerlauf = formkurvenAlle.daten?.find((d) => d.login === login)?.verlauf ?? [];

    // Bestes Monatsergebnis (hoechste Punktzahl, bei Gleichstand der bessere Platz) --
    // "Saison" hier im Sinn von "beste Phase", nicht Kalenderjahr (siehe kiAnalysen-Schema).
    let besteSaison = null;
    for (const eintrag of eigenerVerlauf) {
        const besser = !besteSaison
            || eintrag.punkte > besteSaison.punkte
            || (eintrag.punkte === besteSaison.punkte && eintrag.platz < besteSaison.platz);
        if (besser) besteSaison = { monat: eintrag.monat, punkte: eintrag.punkte, platz: eintrag.platz };
    }

    const aktuelleForm = eigenerVerlauf.slice(-3).map((e) => ({
        monat: e.monat, punkte: e.punkte, platz: e.platz, gleitenderSchnitt3: e.gleitenderSchnitt3,
    }));

    // Persoenliche Bestzeit je Map (eigenes Minimum ueber archivRecords+records hinweg,
    // nicht der Server-Rekord) -- mit dem Monat, in dem diese Bestzeit gefahren wurde.
    const persoenlicheBests = {};
    for (const r of alleRecordsMitMonat) {
        if (r.login !== login || !r.map || !Number.isFinite(r.time)) continue;
        const bisher = persoenlicheBests[r.map];
        if (!bisher || r.time < bisher.zeit) persoenlicheBests[r.map] = { zeit: r.time, monat: r.monat ?? 'live' };
    }

    const rivalitaeten = berechneRivalitaeten(echteMonate);
    const kopfAnKopf = (rivalitaeten.daten ?? [])
        .filter((r) => r.loginA === login || r.loginB === login)
        .map((r) => {
            const istA = r.loginA === login;
            return {
                gegnerLogin: istA ? r.loginB : r.loginA,
                gegnerName: istA ? r.nameB : r.nameA,
                engeMonate: r.anzahlMonate,
                aktuellerAbstand: r.letzterAbstand,
            };
        });

    const dominanz = berechneDominanz(alleRecordsMitMonat);
    const dominanteMaps = (dominanz.daten ?? []).filter((d) => d.login === login).map((d) => d.map);

    const eigeneKarma = karmaEintraege.filter((k) => k.login === login);
    const karmaSchnitt = eigeneKarma.length > 0
        ? Math.round((eigeneKarma.reduce((s, k) => s + k.score, 0) / eigeneKarma.length) * 10) / 10
        : null;

    // Comeback-Erkennung kommt aus derselben Funktion wie die Anomalien-Kennzahl (AP15b) --
    // hier interessiert nur der Comeback-Teil, nicht ungewoehnlicheMonate (kein Dossier-Feld dafuer).
    const anomalien = berechneAnomalien(formkurvenAlle, echteMonate);
    const comeback = (anomalien.daten?.comebacks ?? []).find((c) => c.login === login);

    return {
        login,
        name: spielerNamen.get(login) ?? login,
        firstSeen: spielerFirstSeen?.get(login) ?? null,
        besteSaison,
        aktuelleForm,
        persoenlicheBests,
        kopfAnKopf,
        dominanteMaps,
        karmaSchnitt,
        comebackNachMonaten: comeback?.pauseMonate ?? null,
    };
}
