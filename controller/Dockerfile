# Controller-Image. Build-Context ist bewusst das REPO-ROOT (nicht controller/),
# da der Controller Module aus dem Geschwister-Ordner scripts/ importiert
# (z.B. controller/plugins/telegram.js -> scripts/lib/*.js) und die Skripte aus
# scripts/ (monatswechsel.js, backup-db.js, ...) per "docker compose exec
# controller node ../scripts/<script>.js" als Cron-Jobs im selben Container
# laufen sollen (siehe SETUP.md). Aufruf: docker build -f controller/Dockerfile .
FROM node:20-alpine

WORKDIR /app

# Controller-Abhaengigkeiten
COPY controller/package.json controller/package-lock.json ./controller/
RUN cd controller && npm ci --omit=dev

# Abhaengigkeiten der scripts/-CLI-Tools (fuer die per "docker compose exec"
# gestarteten Cron-Jobs wie monatswechsel.js/backup-db.js)
COPY scripts/package.json scripts/package-lock.json ./scripts/
RUN cd scripts && npm ci --omit=dev

# Quellcode
COPY controller ./controller
COPY scripts ./scripts

WORKDIR /app/controller

# Wird per Compose auf einen gemounteten Secrets-Ordner umgebogen (siehe
# docker-compose.yml) -- Default hier nur als Dokumentation.
ENV TRACKMANIA_SECRETS_PATH=/run/secrets/secrets.env

CMD ["node", "."]
