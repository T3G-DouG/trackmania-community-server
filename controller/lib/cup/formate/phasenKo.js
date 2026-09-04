// phasenKo.js -- Cup-Turniersystem (Beta-Feature): Format "Phasen-KO" ("alle
// fahren"). turnier.config.formatConfig.phasen = [{name, rundenProMap, mapAnzahl,
// weiterkommen}, ...]. Jede Phase besteht aus (mapAnzahl * rundenProMap) Runden;
// danach steigen die besten `weiterkommen` Teilnehmer (nach Phasen-Punkten aus
// turnier.config.punkteProRunde) in die naechste Phase auf, der Rest scheidet aus.
// Reine Funktionen, kein nextcontrol-Import (Testbarkeitsregel).

const ID = 'phasenko';

function phasenListe(turnier) {
    return turnier.config.formatConfig.phasen;
}

function aktuellePhase(turnier) {
    return phasenListe(turnier)[turnier.verlauf.phaseIndex];
}

function rundenZielAktuellePhase(turnier) {
    const phase = aktuellePhase(turnier);
    return phase.mapAnzahl * phase.rundenProMap + (turnier.verlauf.stechrundenExtra ?? 0);
}

function punkteFuerPlatz(turnier, platz) {
    const tabelle = turnier.config.punkteProRunde ?? [10, 6, 4, 3, 2, 1];
    return tabelle[platz - 1] ?? 0;
}

function nameFuerLogin(turnier, login) {
    return turnier.teilnehmer.find((t) => t.login === login)?.name ?? login;
}

function initVerlauf(turnier) {
    return {
        phaseIndex: 0,
        mapIndex: 0,
        rundenNr: 0,
        stechrundenExtra: 0,
        punkte: {},
        rundenErgebnisse: [],
        ausgeschieden: [],
        aktivTeilnehmer: turnier.teilnehmer.map((t) => t.login),
        getrennt: [],
    };
}

/**
 * Sortiert aktive Teilnehmer nach Phasen-Punkten absteigend, Tiebreaker: Platz der
 * jeweils letzten gemeinsam gespielten Runde aufsteigend (kleinerer Platz = besser).
 * @returns {{sortiert: string[], strittig: boolean}} strittig = echte Restgleichheit
 *          am Schnitt (Punkte UND letzte Runde identisch) -- braucht eine Stechrunde.
 */
function sortierePhase(turnier, punkte, aktivTeilnehmer, cutIndex) {
    const letzteRundeProLogin = {};
    const rundenDieserPhase = turnier.verlauf.rundenErgebnisse.filter((r) => r.phaseIndex === turnier.verlauf.phaseIndex);
    const letzteRunde = rundenDieserPhase[rundenDieserPhase.length - 1];
    if (letzteRunde) {
        for (const e of letzteRunde.ergebnisse) letzteRundeProLogin[e.login] = e.platz;
    }

    const sortiert = [...aktivTeilnehmer].sort((a, b) => {
        const diffPunkte = (punkte[b] ?? 0) - (punkte[a] ?? 0);
        if (diffPunkte !== 0) return diffPunkte;
        const diffLetzteRunde = (letzteRundeProLogin[a] ?? 999) - (letzteRundeProLogin[b] ?? 999);
        if (diffLetzteRunde !== 0) return diffLetzteRunde;
        return a.localeCompare(b); // deterministischer, aber willkuerlicher Rest-Tiebreak
    });

    let strittig = false;
    if (cutIndex != null && cutIndex > 0 && cutIndex < sortiert.length) {
        const oben = sortiert[cutIndex - 1];
        const unten = sortiert[cutIndex];
        const punkteGleich = (punkte[oben] ?? 0) === (punkte[unten] ?? 0);
        const letzteRundeGleich = (letzteRundeProLogin[oben] ?? 999) === (letzteRundeProLogin[unten] ?? 999);
        strittig = punkteGleich && letzteRundeGleich;
    }

    return { sortiert, strittig };
}

function verarbeiteRunde(turnier, ergebnisse, jetzt) {
    const verlauf = structuredClone(turnier.verlauf);

    for (const { login, platz } of ergebnisse) {
        verlauf.punkte[login] = (verlauf.punkte[login] ?? 0) + punkteFuerPlatz(turnier, platz);
    }
    verlauf.rundenErgebnisse.push({ phaseIndex: verlauf.phaseIndex, rundenNr: verlauf.rundenNr, ergebnisse, zeit: jetzt.toISOString() });
    verlauf.rundenNr += 1;

    const phase = phasenListe(turnier)[verlauf.phaseIndex];
    const rundenZiel = phase.mapAnzahl * phase.rundenProMap + verlauf.stechrundenExtra;

    let ausgeschieden = [];
    let phaseAbgeschlossen = false;
    let turnierAbgeschlossen = false;
    let naechstePhaseIndex = null;

    if (verlauf.rundenNr >= rundenZiel) {
        const istLetztePhase = verlauf.phaseIndex === phasenListe(turnier).length - 1;
        const weiterkommen = Math.min(phase.weiterkommen, verlauf.aktivTeilnehmer.length);
        const { sortiert, strittig } = sortierePhase(turnier, verlauf.punkte, verlauf.aktivTeilnehmer, weiterkommen);

        if (strittig && weiterkommen < verlauf.aktivTeilnehmer.length) {
            // Echte Restgleichheit am Cut -- automatische Stechrunde (eine Runde mehr),
            // KEIN Cut in dieser Runde. Admin kann alternativ `phaseWiederholen` nutzen.
            verlauf.stechrundenExtra += 1;
        } else {
            const bleiben = sortiert.slice(0, weiterkommen);
            const raus = sortiert.slice(weiterkommen);

            const bereitsAusgeschieden = verlauf.ausgeschieden.length;
            const gesamtTeilnehmer = turnier.teilnehmer.length;
            // raus[0] (bester der Ausscheider) bekommt den besten freien Platz,
            // raus[raus.length-1] (schlechtester) den schlechtesten.
            raus.forEach((login, i) => {
                const endPlatz = gesamtTeilnehmer - bereitsAusgeschieden - raus.length + i + 1;
                ausgeschieden.push({ login, name: nameFuerLogin(turnier, login), phase: phase.name, endPlatz });
            });

            if (istLetztePhase || bleiben.length <= 1) {
                turnierAbgeschlossen = true;
                verlauf.aktivTeilnehmer = bleiben;
            } else {
                phaseAbgeschlossen = true;
                naechstePhaseIndex = verlauf.phaseIndex + 1;
                verlauf.phaseIndex += 1;
                verlauf.mapIndex = 0;
                verlauf.rundenNr = 0;
                verlauf.stechrundenExtra = 0;
                verlauf.punkte = {};
                verlauf.aktivTeilnehmer = bleiben;
            }
        }
    }

    return { verlauf, ausgeschieden, phaseAbgeschlossen, turnierAbgeschlossen, naechstePhaseIndex, aktionen: [] };
}

function istPhaseZuEnde(turnier) {
    const phase = aktuellePhase(turnier);
    return turnier.verlauf.rundenNr >= phase.mapAnzahl * phase.rundenProMap + turnier.verlauf.stechrundenExtra;
}

function ermittleAusscheider(turnier) {
    if (!istPhaseZuEnde(turnier)) return [];
    const phase = aktuellePhase(turnier);
    const weiterkommen = Math.min(phase.weiterkommen, turnier.verlauf.aktivTeilnehmer.length);
    const { sortiert } = sortierePhase(turnier, turnier.verlauf.punkte, turnier.verlauf.aktivTeilnehmer, weiterkommen);
    return sortiert.slice(weiterkommen);
}

function rangliste(turnier) {
    const { sortiert } = sortierePhase(turnier, turnier.verlauf.punkte, turnier.verlauf.aktivTeilnehmer, null);
    const gesamtTeilnehmer = turnier.teilnehmer.length;
    const aktive = sortiert.map((login, i) => ({
        platz: i + 1,
        login,
        name: nameFuerLogin(turnier, login),
        punkte: turnier.verlauf.punkte[login] ?? 0,
    }));
    const ausgeschiedeneSortiert = [...turnier.verlauf.ausgeschieden].sort((a, b) => a.endPlatz - b.endPlatz);
    return [...aktive, ...ausgeschiedeneSortiert.map((a) => ({ platz: a.endPlatz, login: a.login, name: a.name }))]
        .sort((a, b) => a.platz - b.platz)
        .slice(0, gesamtTeilnehmer);
}

function wiederholePhase(turnier) {
    const verlauf = structuredClone(turnier.verlauf);
    verlauf.rundenNr = 0;
    verlauf.stechrundenExtra = 0;
    verlauf.punkte = {};
    verlauf.rundenErgebnisse = verlauf.rundenErgebnisse.filter((r) => r.phaseIndex !== verlauf.phaseIndex);
    return verlauf;
}

function entferneSpieler(turnier, login) {
    const verlauf = structuredClone(turnier.verlauf);
    verlauf.aktivTeilnehmer = verlauf.aktivTeilnehmer.filter((l) => l !== login);
    if (!verlauf.ausgeschieden.some((a) => a.login === login)) {
        const gesamtTeilnehmer = turnier.teilnehmer.length;
        const endPlatz = gesamtTeilnehmer - verlauf.ausgeschieden.length;
        verlauf.ausgeschieden.push({ login, name: nameFuerLogin(turnier, login), phase: aktuellePhase(turnier).name, endPlatz });
    }
    return verlauf;
}

function holeSpielerZurueck(turnier, login) {
    const verlauf = structuredClone(turnier.verlauf);
    verlauf.ausgeschieden = verlauf.ausgeschieden.filter((a) => a.login !== login);
    if (!verlauf.aktivTeilnehmer.includes(login)) verlauf.aktivTeilnehmer.push(login);
    verlauf.getrennt = verlauf.getrennt.filter((l) => l !== login);
    return verlauf;
}

export const phasenKo = {
    id: ID,
    initVerlauf,
    verarbeiteRunde,
    istPhaseZuEnde,
    ermittleAusscheider,
    rangliste,
    wiederholePhase,
    entferneSpieler,
    holeSpielerZurueck,
};
