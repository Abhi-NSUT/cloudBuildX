# ==========================================
# STAGE 1: Builder
# ==========================================
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
# Install all dependencies (including dev tools like TypeScript)
RUN npm ci 

COPY . .
# Generate Prisma client and compile TypeScript
RUN npx prisma generate
RUN npm run build

# ==========================================
# STAGE 2: Production Runner
# ==========================================
FROM node:20-alpine AS runner
WORKDIR /app

COPY package*.json ./
# Install ONLY production dependencies to save space
RUN npm ci --omit=dev

# Copy the compiled output and Prisma engine from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Copy Prisma schema just in case runtime needs it
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000

# Run the compiled JavaScript natively
CMD ["node", "dist/index.js"]
