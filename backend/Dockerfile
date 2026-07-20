FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend ./
RUN npm run build
CMD ["sh", "-c", "npm run migrate && npm start"]
