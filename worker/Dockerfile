# ==========================================
# STAGE 1: Builder
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci 

COPY . .
RUN npx prisma generate
RUN npm run build

# ==========================================
# STAGE 2: Production Runner
# ==========================================
FROM node:20-alpine AS runner
WORKDIR /app

# Install the Docker CLI to allow Docker-in-Docker commands via Dockerode, and git to clone repos
RUN apk add --no-cache docker-cli git

COPY package*.json ./
RUN npm ci --omit=dev

# Install PM2 globally to manage the worker cluster
RUN npm install -g pm2

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/prisma ./prisma

# Copy the PM2 cluster configuration
COPY ecosystem.config.js ./

CMD ["pm2-runtime", "ecosystem.config.js"]
