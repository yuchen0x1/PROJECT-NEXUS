FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV NEXUS_HOST=0.0.0.0
EXPOSE 4317
CMD ["npm", "start"]
