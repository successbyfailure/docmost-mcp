FROM node:20-alpine

WORKDIR /app

# Copiamos archivos mínimos primero para aprovechar cache
COPY package.json ./

# Copiar el código fuente
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
