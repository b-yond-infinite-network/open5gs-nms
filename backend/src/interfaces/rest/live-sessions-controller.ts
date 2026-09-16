import { Router, Request, Response } from 'express';
import pino from 'pino';
import { LiveSessionsUseCase } from '../../application/use-cases/live-sessions';

export function createLiveSessionsRouter(
  liveSessionsUseCase: LiveSessionsUseCase,
  logger: pino.Logger,
): Router {
  const router = Router();

  //Counts only — one metrics scrape per NF, cheap enough to poll.
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const counts = await liveSessionsUseCase.getCounts();
      res.json({ success: true, data: counts });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to read live session counts');
      res.status(500).json({ success: false, error: msg });
    }
  });

  //Per-UE rows — several execs per UE, so this is a separate, explicit call.
  router.get('/ues', async (_req: Request, res: Response) => {
    try {
      const detail = await liveSessionsUseCase.getUeDetail();
      res.json({ success: true, data: detail });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to read live UE detail');
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}
