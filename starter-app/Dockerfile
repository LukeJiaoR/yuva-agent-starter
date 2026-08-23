FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY . .
RUN npm ci --omit=dev

EXPOSE 3000
CMD ["npm", "start"]
