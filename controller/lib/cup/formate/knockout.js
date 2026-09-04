// knockout.js -- Cup-Turniersystem (Beta-Feature): Format "Knockout". Jede Runde
// verliert der/die Letztplatzierte(n) ein Leben (turnier.config.formatConfig.leben,
// Standard 1 -- "Doppel-Leben" ist einfach leben:2, keine Sonderbehandlung noetig);
// bei 0 Leben scheidet der Teilnehmer aus. Die Karte wechselt automatisch alle
// `rundenProMap` Runden (Modulo ueber den Kartenpool). Keine Phasen im Sinn von
// phasenKo.js -- "Phase" == das ganze Turnier, endet wenn <=1 Teilnehmer aktiv ist.
// Reine Funktionen, kein nextcontrol-Import (Testbarkeitsregel).

const ID = 'knockout';

function nameFuerLogin(turnier, login) {
    return turnier.teilnehmer.find((t) => t.login === login)?.name ?? login;
}

function initVerlauf(turnier) {
    const leben = turnier.config.formatConfig.leben ?? 1;
    const lebenProLogin = {};
    for (const t of turnier.teilnehmer) lebenProLogin[t.login] = leben;
    return {
        phaseIndex: 0, // Knockout kennt keine Phasen -- Konstante 0, Feld existiert fuer ein gemeinsames Schema mit phasenKo
        mapIndex: 0,
        rundenAufAktuellerMap: 0,
        rundenNr: 0,
        leben: lebenProLogin,
        rundenErgebnisse: [],
        ausgeschieden: [],
        aktivTeilnehmer: turnier.teilnehmer.map((t) => t.login),
        getrennt: [],
    };
}

function verarbeiteRunde(turnier, ergebnisse, jetzt) {
    const verlauf = structuredClone(turnier.verlauf);
    const config = turnier.config.formatConfig;

    verlauf.rundenErgebnisse.push({ phaseIndex: 0, rundenNr: verlauf.rundenNr, ergebnisse, zeit: jetzt.toISOString() });
    verlauf.rundenNr += 1;
    verlauf.rundenAufAktuellerMap += 1;

    const schlechtesterPlatz = Math.max(...ergebnisse.map((e) => e.platz), 0);
    const letzte = ergebnisse.filter((e) => e.platz === schlechtesterPlatz).map((e) => e.login);

    const ausgeschieden = [];
    for (const login of letzte) {
        verlauf.leben[login] = (verlauf.leben[login] ?? 1) - 1;
        if (verlauf.leben[login] <= 0 && verlauf.aktivTeilnehmer.includes(login)) {
            verlauf.aktivTeilnehmer = verlauf.aktivTeilnehmer.filter((l) => l !== login);
            const gesamtTeilnehmer = turnier.teilnehmer.length;
            const endPlatz = gesamtTeilnehmer - verlauf.ausgeschieden.length;
            ausgeschieden.push({ login, name: nameFuerLogin(turnier, login), phase: 'Knockout', endPlatz });
        }
    }

    if (verlauf.rundenAufAktuellerMap >= config.rundenProMap) {
        verlauf.rundenAufAktuellerMap = 0;
        const anzahlMaps = turnier.config.maps.length;
        if (anzahlMaps > 0) verlauf.mapIndex = (verlauf.mapIndex + 1) % anzahlMaps;
    }

    const turnierAbgeschlossen = verlauf.aktivTeilnehmer.length <= 1;

    return {
        verlauf,
        ausgeschieden,
        phaseAbgeschlossen: turnierAbgeschlossen, // Knockout: Phasenende == Turnierende
        turnierAbgeschlossen,
        naechstePhaseIndex: null,
        aktionen: [],
    };
}

function istPhaseZuEnde(turnier) {
    return turnier.verlauf.aktivTeilnehmer.length <= 1;
}

function ermittleAusscheider(turnier) {
    // Rein informativ: wer aktuell auf 1 Leben steht (naechster Verlust = raus).
    return turnier.verlauf.aktivTeilnehmer.filter((login) => (turnier.verlauf.leben[login] ?? 1) <= 1);
}

function rangliste(turnier) {
    const gesamtTeilnehmer = turnier.teilnehmer.length;
    const aktive = [...turnier.verlauf.aktivTeilnehmer]
        .sort((a, b) => (turnier.verlauf.leben[b] ?? 0) - (turnier.verlauf.leben[a] ?? 0))
        .map((login, i) => ({ platz: i + 1, login, name: nameFuerLogin(turnier, login), leben: turnier.verlauf.leben[login] ?? 0 }));
    const ausgeschiedeneSortiert = [...turnier.verlauf.ausgeschieden].sort((a, b) => a.endPlatz - b.endPlatz);
    return [...aktive, ...ausgeschiedeneSortiert.map((a) => ({ platz: a.endPlatz, login: a.login, name: a.name }))]
        .sort((a, b) => a.platz - b.platz)
        .slice(0, gesamtTeilnehmer);
}

function wiederholePhase(turnier) {
    // Knockout hat keine "Phase" im Sinn von phasenKo -- interpretiert als
    // "letzte Runde zuruecknehmen" waere zustandsbehaftet/riskant; stattdessen wird
    // schlicht die aktuelle Runde nicht gezaehlt (kein Effekt, Admin spielt neu aus).
    return structuredClone(turnier.verlauf);
}

function entferneSpieler(turnier, login) {
    const verlauf = structuredClone(turnier.verlauf);
    verlauf.aktivTeilnehmer = verlauf.aktivTeilnehmer.filter((l) => l !== login);
    if (!verlauf.ausgeschieden.some((a) => a.login === login)) {
        const gesamtTeilnehmer = turnier.teilnehmer.length;
        const endPlatz = gesamtTeilnehmer - verlauf.ausgeschieden.length;
        verlauf.ausgeschieden.push({ login, name: nameFuerLogin(turnier, login), phase: 'Knockout', endPlatz });
    }
    return verlauf;
}

function holeSpielerZurueck(turnier, login) {
    const verlauf = structuredClone(turnier.verlauf);
    verlauf.ausgeschieden = verlauf.ausgeschieden.filter((a) => a.login !== login);
    if (!verlauf.aktivTeilnehmer.includes(login)) verlauf.aktivTeilnehmer.push(login);
    verlauf.leben[login] = Math.max(verlauf.leben[login] ?? 0, 1);
    verlauf.getrennt = verlauf.getrennt.filter((l) => l !== login);
    return verlauf;
}

export const knockout = {
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
