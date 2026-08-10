# ==========================================
# STAGE 1: React Compiler
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# Compile the React application into the /dist folder
RUN npm run build

# ==========================================
# STAGE 2: Nginx Web Server
# ==========================================
FROM nginx:alpine

# Copy the static files from the builder stage to Nginx's default public folder
COPY --from=builder /app/dist /usr/share/nginx/html
# Optional: If you use React Router, you need to configure Nginx to redirect 404s to index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 80 for web traffic
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
