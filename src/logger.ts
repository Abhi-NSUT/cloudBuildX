import winston from 'winston';

const isProduction = process.env.NODE_ENV === 'production';

// Structured JSON in production (easy to ship to CloudWatch/Loki),
// colourised one-liners in development.
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  silent: process.env.NODE_ENV === 'test',
  defaultMeta: { service: 'api' },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    isProduction
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
            const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp} [${service}] ${level}: ${message}${extra}`;
          })
        )
  ),
  transports: [new winston.transports.Console()],
});
