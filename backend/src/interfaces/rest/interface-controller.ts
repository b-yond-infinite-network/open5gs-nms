import { Router } from 'express';
import pino from 'pino';
import { GetInterfaceStatus } from '../../application/use-cases/interface-status/get-interface-status';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { ActiveSessionsUseCase } from '../../application/use-cases/active-sessions';
import { LiveSessionsUseCase } from '../../application/use-cases/live-sessions';

export const createInterfaceRouter = (
  hostExecutor: IHostExecutor,
  logger: pino.Logger,
  activeSessionsUseCase: ActiveSessionsUseCase,
  configRepo: IConfigRepository,
  liveSessionsUseCase: LiveSessionsUseCase,
): Router => {
  const router = Router();
  const getInterfaceStatus = new GetInterfaceStatus(
    hostExecutor,
    logger,
    activeSessionsUseCase,
    configRepo,
    liveSessionsUseCase,
  );

  router.get('/', async (req, res) => {
    //Off by default: the counts come back on every poll, the per-UE walk only
    //when a caller asks for it.
    const includeUeDetail = req.query.detail === 'true' || req.query.detail === '1';

    try {
      const status = await getInterfaceStatus.execute({ includeUeDetail });
      res.json(status);
    } catch (error) {
      logger.error({ error }, 'Failed to get interface status');
      res.status(500).json({ error: 'Failed to get interface status' });
    }
  });

  return router;
};
