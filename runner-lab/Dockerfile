# Noll npm-beroenden, så bilden behöver bara Node och källkoden.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web

# Arkivet är produktens värde och måste ligga på en volym som överlever
# omstarter. Utan det tappas creator-historiken varje gång containern byts ut.
VOLUME /app/data
ENV DATA_DIR=/app/data/ HOST=0.0.0.0 PORT=4173
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "src/index.js"]
