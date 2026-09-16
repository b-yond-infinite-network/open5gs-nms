import { Router, Request, Response } from 'express';
import { SubscriberManagementUseCase } from '../../application/use-cases/subscriber-management';
import { AutoAssignIPsUseCase } from '../../application/use-cases/auto-assign-ips-usecase';
import {
  K8sLabUseCase,
  K8sScriptResult,
  SubscriberUeAction,
} from '../../application/use-cases/k8s-lab';
import pino from 'pino';

const VALID_SUBSCRIBER_UE_ACTIONS: SubscriberUeAction[] = ['attach', 'detach', 'traffic', 'check'];

function scriptFailure(result: K8sScriptResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `${result.message}: ${detail}` : result.message;
}

export function createSubscriberRouter(
  subscriberUC: SubscriberManagementUseCase,
  autoAssignIPsUC: AutoAssignIPsUseCase,
  k8sLabUC: K8sLabUseCase,
  logger: pino.Logger
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const skip = parseInt(req.query.skip as string) || 0;
      const limit = parseInt(req.query.limit as string) || 50;
      const search = req.query.search as string | undefined;
      const result = search ? await subscriberUC.search(search, skip, limit) : await subscriberUC.list(skip, limit);
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'Failed to list subscribers');
      res.status(500).json({ error: 'Failed to list subscribers' });
    }
  });

  // Get IP assignments for all subscribers (MUST be before /:imsi route)
  router.get('/ip-assignments', async (req: Request, res: Response) => {
    try {
      const assignments = await autoAssignIPsUC.getIPAssignments();
      res.json({
        success: true,
        data: assignments,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get IP assignments');
      res.status(500).json({ success: false, error: 'Failed to get IP assignments' });
    }
  });

  router.get('/ue-status', async (req: Request, res: Response) => {
    try {
      const imsis = String(req.query.imsis || '')
        .split(',')
        .map((imsi) => imsi.trim())
        .filter(Boolean);
      const statuses = await k8sLabUC.getSubscriberUeStatuses(imsis);
      res.json({ success: true, data: statuses });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to check UE status';
      logger.error({ err: msg }, 'Failed to check subscriber UE status');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.get('/:imsi', async (req: Request, res: Response) => {
    try {
      const subscriber = await subscriberUC.getByImsi(req.params.imsi);
      if (!subscriber) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(subscriber);
    } catch (err) {
      logger.error({ err }, 'Failed to get subscriber');
      res.status(500).json({ error: 'Failed to get subscriber' });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    let createdImsi: string | null = null;
    try {
      await subscriberUC.create(req.body);
      const imsi = String(req.body.imsi);
      createdImsi = imsi;

      const ueResult = await k8sLabUC.createSubscriberUe(imsi);
      if (!ueResult.success) {
        throw new Error(scriptFailure(ueResult));
      }

      res.status(201).json({ message: 'Subscriber and UE configuration created', ue: ueResult });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create subscriber';
      if (createdImsi) {
        try {
          await subscriberUC.delete(createdImsi);
        } catch (rollbackErr) {
          logger.error({ err: rollbackErr, imsi: createdImsi }, 'Failed to roll back subscriber');
        }
      }
      logger.error({ err: msg, imsi: createdImsi }, 'Failed to create subscriber UE');
      res.status(createdImsi ? 502 : 400).json({ error: msg });
    }
  });

  router.put('/:imsi', async (req: Request, res: Response) => {
    try {
      await subscriberUC.update(req.params.imsi, req.body);
      res.json({ message: 'Updated' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed';
      res.status(400).json({ error: msg });
    }
  });

  router.post('/:imsi/ue/:action', async (req: Request, res: Response) => {
    const action = req.params.action as SubscriberUeAction;
    if (!VALID_SUBSCRIBER_UE_ACTIONS.includes(action)) {
      res.status(400).json({ success: false, error: `Invalid UE action: ${req.params.action}` });
      return;
    }

    try {
      const subscriber = await subscriberUC.getByImsi(req.params.imsi);
      if (!subscriber) {
        res.status(404).json({ success: false, error: 'Subscriber not found' });
        return;
      }

      const result = await k8sLabUC.runSubscriberUeAction(req.params.imsi, action);
      res.status(result.success ? 200 : 500).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to run UE action';
      logger.error({ err: msg, imsi: req.params.imsi, action }, 'Failed subscriber UE action');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.delete('/:imsi', async (req: Request, res: Response) => {
    try {
      const subscriber = await subscriberUC.getByImsi(req.params.imsi);
      if (!subscriber) {
        res.status(404).json({ error: 'Subscriber not found' });
        return;
      }

      const ueResult = await k8sLabUC.removeSubscriberUe(req.params.imsi);
      if (!ueResult.success) {
        res.status(500).json({ error: scriptFailure(ueResult), ue: ueResult });
        return;
      }

      await subscriberUC.delete(req.params.imsi);
      res.json({ message: 'Subscriber and UE removed', ue: ueResult });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to remove subscriber';
      logger.error({ err: msg, imsi: req.params.imsi }, 'Failed to remove subscriber UE');
      res.status(500).json({ error: msg });
    }
  });

  // Auto-assign IPs to all subscribers
  router.post('/auto-assign-ips', async (req: Request, res: Response) => {
    try {
      logger.info('Auto-assigning IPs to all subscribers');
      const result = await autoAssignIPsUC.execute();
      res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to auto-assign IPs');
      const msg = err instanceof Error ? err.message : 'Failed to auto-assign IPs';
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}
