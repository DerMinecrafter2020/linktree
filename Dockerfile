FROM node:20-alpine

# Setze Umgebungsvariablen
ENV NODE_ENV=production
ENV PORT=3000

# Arbeitsverzeichnis erstellen und Rechte an 'node'-User uebergeben
WORKDIR /app
RUN chown -R node:node /app

# Wechsle zu sicherem, nicht-root User
USER node

# Package-Dateien kopieren
COPY --chown=node:node package*.json ./

# Abhängigkeiten installieren (ohne devDependencies)
RUN npm ci --only=production && npm cache clean --force

# Quellcode kopieren
COPY --chown=node:node . .

# Port freigeben
EXPOSE 3000

# Healthcheck für den Container
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Anwendung starten
CMD ["node", "server.js"]
