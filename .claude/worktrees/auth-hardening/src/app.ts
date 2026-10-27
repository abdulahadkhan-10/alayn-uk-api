import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import rateLimit from 'express-rate-limit';
import { errorMiddleware } from './middleware/error.middleware';
import routes from './routes';
import { swaggerDocument } from './config/swagger';
import { isAllowedOrigin } from './config/cors';

const app = express();

// Production sits behind one reverse proxy that terminates TLS. Without this,
// req.ip is the proxy's address for every request, so each per-IP rate limit
// is shared by all clients at once.
app.set('trust proxy', 1);

// Security Middlewares
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Same allowlist as Socket.IO (see config/cors.ts). Requests with no Origin header are
    // server-to-server, mobile or tool calls.
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'x-outlet-id',
    'X-Outlet-Id',
    'x-refresh-token',
    'X-Refresh-Token',
    'x-business-id',
    'X-Business-Id',
    'x-active-branch-id',
    'X-Active-Branch-Id',
    'x-portal',
    'X-Portal',
    'x-token-delivery',
    'X-Token-Delivery',
    'Cache-Control',
    'Pragma',
  ],
  exposedHeaders: ['Set-Cookie'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));


// Request Parsers
app.use(cookieParser());
// Sign-in, sign-up and password-reset bodies are tiny. Parsing them here with a small limit means
// the 50 MB parser below (needed for uploads elsewhere) never sees them, so unauthenticated
// callers cannot make the server buffer huge payloads.
app.use('/api/v1/auth', express.json({ limit: '16kb' }));
app.use(
  express.json({
    limit: '50mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    }
  })
);
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve Static Uploads
import path from 'path';
app.use(
  '/uploads',
  cors(),
  express.static(path.resolve(__dirname, '../uploads'), {
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
    },
  })
);

// Swagger UI Documentation
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Broad per-IP ceiling for the whole API. Set well above what a busy outlet
// generates (several POS, kitchen and dashboard devices share one IP); its
// main job is to stop runaway clients and to send RateLimit headers so API
// clients and agents can throttle themselves. Payment webhooks are exempt.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/subscriptions/webhook'),
  message: {
    success: false,
    error: {
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many requests. Please slow down and retry after the time in the Retry-After header.',
    },
  },
});

// Route Mappings
app.use('/api/v1', apiLimiter, routes);

// Base Route
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the Alayn Operations & Management Platform API',
    docs: '/api/docs',
  });
});

// Error handling middleware (MUST be last)
app.use(errorMiddleware);

export { app };
export default app;
