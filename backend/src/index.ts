import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { WebSocketServer } from 'ws';
import pino from 'pino';
import { loadAppConfig } from './config';
import { LocalHostExecutor } from './infrastructure/system/local-host-executor';
import { YamlConfigRepository } from './infrastructure/yaml/yaml-config-repository';
import { MongoSubscriberRepository } from './infrastructure/mongodb/mongo-subscriber-repository';
import { MongoUriResolver } from './infrastructure/mongodb/mongo-uri-resolver';
import { FileAuditLogger } from './infrastructure/logging/file-audit-logger';
import { WssBroadcaster } from './infrastructure/websocket/wss-broadcaster';
import { LoadConfigUseCase } from './application/use-cases/load-config';
import { ValidateConfigUseCase } from './application/use-cases/validate-config';
import { ApplyConfigUseCase } from './application/use-cases/apply-config';
import { KubernetesServiceMonitorUseCase } from './application/use-cases/kubernetes-service-monitor';
import { SubscriberManagementUseCase } from './application/use-cases/subscriber-management';
import { TopologyUseCase } from './application/use-cases/topology';
import { BackupRestoreUseCase } from './application/use-cases/backup-restore';
import { RestoreDefaultsUseCase } from './application/use-cases/restore-defaults';
import { AutoConfigUseCase } from './application/use-cases/auto-config';
import { LogStreamingUseCase } from './application/use-cases/log-streaming';
import { DockerLogStreamingUseCase } from './application/use-cases/docker-log-streaming';
import { DockerLogExecutor } from './infrastructure/docker/docker-log-executor';
import { LogStreamHandler } from './infrastructure/websocket/log-stream-handler';
import { SqliteAuthRepository, createLucia } from './infrastructure/auth/sqlite-auth-repository';
import { seedAdminUser } from './infrastructure/auth/seed-admin';
import { AuthLoginUseCase } from './application/use-cases/auth-login';
import { AuthLogoutUseCase } from './application/use-cases/auth-logout';
import { createAuthRouter } from './interfaces/rest/auth-controller';
import { createAuthMiddleware } from './interfaces/rest/middleware/auth-middleware';
import { UserManagementUseCase } from './application/use-cases/user-management';
import { createUsersRouter } from './interfaces/rest/users-controller';
import { createConfigRouter } from './interfaces/rest/config-controller';
import { createBackupRouter } from './interfaces/rest/backup-controller';
import { createAutoConfigRouter } from './interfaces/rest/auto-config-controller';
import { createServiceRouter } from './interfaces/rest/service-controller';
import { createSubscriberRouter } from './interfaces/rest/subscriber-controller';
import { createAuditRouter } from './interfaces/rest/audit-controller';
import { createInterfaceRouter } from './interfaces/rest/interface-controller';
import { ActiveSessionsUseCase } from './application/use-cases/active-sessions';
import { SuciManagementUseCase } from './application/use-cases/suci-management';
import { SyncSDUseCase } from './application/use-cases/sync-sd-usecase';
import { AutoAssignIPsUseCase } from './application/use-cases/auto-assign-ips-usecase';
import { createSuciRouter } from './interfaces/rest/suci-controller';
import { createDockerRouter } from './interfaces/rest/docker-controller';
import { K8sLabUseCase } from './application/use-cases/k8s-lab';
import { createK8sRouter } from './interfaces/rest/k8s-controller';
import { LiveSessionsUseCase } from './application/use-cases/live-sessions';
import { createLiveSessionsRouter } from './interfaces/rest/live-sessions-controller';

async function main() {
  // Load configuration
  const config = loadAppConfig();

  // Initialize logger
  const logger = pino({
    level: config.logLevel,
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          },
  });

  logger.info({ config }, 'Starting Open5GS NMS Backend');

  // Initialize infrastructure components
  const hostExecutor = new LocalHostExecutor(logger, config.systemctlPath);
  const configRepo = new YamlConfigRepository(hostExecutor, config.configPath, logger);
  const mongoUriResolver = new MongoUriResolver(
    config.mongodbUri,
    config.mongodbK8sService,
    hostExecutor,
    config.k8sKubeconfig,
    config.k8sExecUser,
    logger,
  );
  const subscriberRepo = new MongoSubscriberRepository(mongoUriResolver, logger);
  const auditLogger = new FileAuditLogger(config.logDir, logger);

  // Initialize audit logger
  await auditLogger.initialize();
  logger.info('Audit logger initialized');

  // Connect to MongoDB. A dynamic address is resolved here and again on every
  // reconnect, so the lab can be stopped and started without restarting the NMS.
  await subscriberRepo.connect();
  logger.info({ target: mongoUriResolver.describe() }, 'MongoDB connection initialised');

  // ── Auth setup ──
  const authRepo = new SqliteAuthRepository(config.authDbPath, logger);
  await seedAdminUser(authRepo, config.firstRunPassword, logger);
  const lucia = createLucia(authRepo.getLuciaAdapter(), config.sessionMaxAge, config.isProduction);
  const authLoginUseCase = new AuthLoginUseCase(authRepo, lucia, logger);
  const authLogoutUseCase = new AuthLogoutUseCase(lucia, logger);
  const userManagementUseCase = new UserManagementUseCase(authRepo, lucia, logger);
  const authMiddleware = createAuthMiddleware(lucia);
  logger.info({ dbPath: config.authDbPath }, 'Auth initialised');

  // Ensure backup directories exist
  try {
    await hostExecutor.createDirectory(config.backupPath);
    await hostExecutor.createDirectory(config.mongoBackupPath);
    logger.info({ configBackup: config.backupPath, mongoBackup: config.mongoBackupPath }, 'Backup directories initialized');
  } catch (err) {
    logger.warn({ err: String(err) }, 'Failed to create backup directories (may already exist)');
  }

  // Initialize WebSocket server
  //
  // The socket carries the same privileges as the REST API: it streams the core's
  // logs and starts a UE's traffic test, which runs a script on the host. Every
  // /api route sits behind authMiddleware, so the handshake is checked against the
  // same session here rather than leaving this channel open.
  const wss = new WebSocketServer({
    port: config.wsPort,
    verifyClient: ({ req }, done) => {
      const sessionId = lucia.readSessionCookie(req.headers.cookie ?? '');
      if (!sessionId) {
        done(false, 401, 'Unauthorized');
        return;
      }
      lucia
        .validateSession(sessionId)
        .then(({ session }) => done(Boolean(session), 401, 'Unauthorized'))
        .catch((err: unknown) => {
          logger.error({ err: String(err) }, 'WebSocket session validation failed');
          done(false, 500, 'Internal Server Error');
        });
    },
  });
  const wsBroadcaster = new WssBroadcaster(wss, logger);
  logger.info({ wsPort: config.wsPort }, 'WebSocket server started');

  // Initialize use cases
  const loadConfigUseCase = new LoadConfigUseCase(configRepo, auditLogger, logger);
  const validateConfigUseCase = new ValidateConfigUseCase(configRepo, logger);
  const applyConfigUseCase = new ApplyConfigUseCase(
    configRepo,
    hostExecutor,
    auditLogger,
    wsBroadcaster,
    validateConfigUseCase,
    logger,
    config.backupPath,
  );
  // FIXED: Correct parameter order for ServiceMonitorUseCase
  // constructor(hostExecutor, wsBroadcaster, auditLogger, logger)
  const serviceMonitorUseCase = new KubernetesServiceMonitorUseCase(
    hostExecutor,
    wsBroadcaster,
    auditLogger,
    logger,
    config.k8sKubeconfig,
    config.k8sExecUser,
  );
  const subscriberManagementUseCase = new SubscriberManagementUseCase(
    subscriberRepo,
    auditLogger,
    logger,
  );
  const topologyUseCase = new TopologyUseCase(configRepo, logger);
  const backupRestoreUseCase = new BackupRestoreUseCase(
    hostExecutor,
    configRepo,
    logger,
    config.backupPath,
    config.mongoBackupPath,
    mongoUriResolver,
  );
  const restoreDefaultsUseCase = new RestoreDefaultsUseCase(
    hostExecutor,
    configRepo,
    auditLogger,
    logger,
    config.backupPath,
  );
  const autoConfigUseCase = new AutoConfigUseCase(
    hostExecutor,
    configRepo,
    auditLogger,
    logger,
    config.backupPath,
  );
  const logStreamingUseCase = new LogStreamingUseCase(hostExecutor, logger);
  const dockerLogExecutor = new DockerLogExecutor(logger);
  const dockerLogStreamingUseCase = new DockerLogStreamingUseCase(dockerLogExecutor, logger);
  const activeSessionsUseCase = new ActiveSessionsUseCase(
    hostExecutor,
    configRepo,
    subscriberRepo,
  );
  const suciManagementUseCase = new SuciManagementUseCase(
    hostExecutor,
    configRepo,
    logger,
  );
  const syncSDUseCase = new SyncSDUseCase(
    configRepo,
    subscriberRepo,
    logger,
  );
  const autoAssignIPsUseCase = new AutoAssignIPsUseCase(
    subscriberRepo,
    configRepo,
    logger,
  );
  const k8sLabUseCase = new K8sLabUseCase(
    hostExecutor,
    logger,
    config.laas5gsaRoot,
    config.k8sKubeconfig,
    config.k8sExecUser,
  );
  const liveSessionsUseCase = new LiveSessionsUseCase(
    hostExecutor,
    logger,
    config.k8sKubeconfig,
    config.k8sExecUser,
    config.k8sNamespace,
  );

  // Initialize log streaming WebSocket handler
  const logStreamHandler = new LogStreamHandler(
    logStreamingUseCase,
    dockerLogStreamingUseCase,
    k8sLabUseCase,
    logger,
  );
  wss.on('connection', (ws) => {
    logStreamHandler.handleConnection(ws);
  });
  logger.info('Log streaming handler initialized');

  // Start service monitoring
  serviceMonitorUseCase.startPolling(5000);
  logger.info('Service monitoring started');

  // Create Express app
  const app = express();

  // Middleware
  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));

  // Health check (public — no auth)
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      wsConnections: wsBroadcaster.getConnectionCount(),
    });
  });

  // Auth routes (public — login endpoint must be reachable before auth)
  app.use('/api/auth', createAuthRouter(authLoginUseCase, authLogoutUseCase, logger));

  // ── Auth middleware ── all routes below this line are protected
  app.use('/api', authMiddleware);

  // API Routes
  app.use('/api/users', createUsersRouter(userManagementUseCase, logger));
  app.use(
    '/api/config',
    createConfigRouter(
      loadConfigUseCase,
      validateConfigUseCase,
      applyConfigUseCase,
      topologyUseCase,
      serviceMonitorUseCase,
      syncSDUseCase,
      logger,
    ),
  );
  app.use(
    '/api/services',
    createServiceRouter(serviceMonitorUseCase, logger),
  );
  app.use(
    '/api/subscribers',
    createSubscriberRouter(
      subscriberManagementUseCase,
      autoAssignIPsUseCase,
      k8sLabUseCase,
      logger,
    ),
  );
  app.use('/api/audit', createAuditRouter(auditLogger, logger));
  app.use('/api/backup', createBackupRouter(backupRestoreUseCase, restoreDefaultsUseCase, logger));
  app.use('/api/auto-config', createAutoConfigRouter(autoConfigUseCase));
  app.use(
    '/api/interface-status',
    createInterfaceRouter(hostExecutor, logger, activeSessionsUseCase, configRepo, liveSessionsUseCase),
  );
  app.use('/api/live-sessions', createLiveSessionsRouter(liveSessionsUseCase, logger));
  app.use('/api/suci', createSuciRouter(suciManagementUseCase, logger));
  app.use('/api/docker', createDockerRouter(dockerLogStreamingUseCase, logger));
  app.use('/api/k8s', createK8sRouter(k8sLabUseCase, logger));

  // Error handler
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      logger.error({ err }, 'Unhandled error');
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    },
  );

  // Start HTTP server
  app.listen(config.port, () => {
    logger.info({ port: config.port }, 'HTTP server started');
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down gracefully...');
    serviceMonitorUseCase.stopPolling();
    logStreamHandler.cleanup();
    await subscriberRepo.disconnect();
    wss.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
