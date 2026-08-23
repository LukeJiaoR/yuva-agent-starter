FROM node:24-alpine AS build

WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM nginx:1.27-alpine
COPY starter-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/starter-web/dist /usr/share/nginx/html
EXPOSE 80
