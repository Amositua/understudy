FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
RUN ln -s /app/backend/node_modules /app/node_modules
COPY backend ./
COPY src ../src
RUN npm run build
CMD ["sh", "-c", "npm run migrate && npm start"]
