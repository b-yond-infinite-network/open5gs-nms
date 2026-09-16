import { Router, Request, Response } from 'express';
import pino from 'pino';
import {
  K8sLabAction,
  K8sLabUseCase,
  K8sUeScenario,
  K8sUeScriptAction,
} from '../../application/use-cases/k8s-lab';

const VALID_LAB_ACTIONS: K8sLabAction[] = ['install-node', 'delete-node', 'start-lab', 'stop-lab'];
const VALID_UE_SCENARIOS: K8sUeScenario[] = ['normal', 'auth-error', 'dnn-error', 'imsi-error', 'slice-error'];
const VALID_UE_SCRIPT_ACTIONS: K8sUeScriptAction[] = ['attach', 'detach', 'remove', 'traffic', 'check'];
//How many UEs one call may name. The whole batch is still addressed by naming none.
const MAX_UE_TARGETS = 50;
//Kept in step with the same bound in K8sLabUseCase.createUes
const MAX_UE_COUNT = 50;

export function createK8sRouter(
  k8sLabUseCase: K8sLabUseCase,
  logger: pino.Logger,
): Router {
  const router = Router();

  router.get('/commands', async (_req: Request, res: Response) => {
    try {
      const commands = await k8sLabUseCase.listCommands();
      res.json({ success: true, data: commands });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to list K8s lab commands');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const status = await k8sLabUseCase.getStatus();
      res.json({ success: true, data: status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to get K8s lab status');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.post('/actions/:action', async (req: Request, res: Response) => {
    const action = req.params.action as K8sLabAction;
    if (!VALID_LAB_ACTIONS.includes(action)) {
      res.status(400).json({ success: false, error: `Invalid action: ${action}` });
      return;
    }

    try {
      const result = await k8sLabUseCase.runLabAction(action);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, action }, 'Failed to execute K8s lab action');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.post('/ue/create', async (req: Request, res: Response) => {
    const count = Number(req.body?.count);
    const scenario = (req.body?.scenario || 'normal') as K8sUeScenario;

    if (!VALID_UE_SCENARIOS.includes(scenario)) {
      res.status(400).json({ success: false, error: `Invalid UE scenario: ${scenario}` });
      return;
    }

    //A missing or out-of-range count is the caller's mistake, so answer 400
    //here rather than letting the use case throw into the 500 handler
    if (!Number.isInteger(count) || count < 1 || count > MAX_UE_COUNT) {
      res.status(400).json({
        success: false,
        error: `UE count must be an integer between 1 and ${MAX_UE_COUNT}`,
      });
      return;
    }

    try {
      const result = await k8sLabUseCase.createUes(count, scenario);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, count, scenario }, 'Failed to create UE scripts');
      res.status(500).json({ success: false, error: msg });
    }
  });

  //Body may carry {imsi} or {imsis:[...]} to act on single UEs; an empty body acts
  //on the whole batch, which is what the pre-existing callers send
  router.post('/ue/:action', async (req: Request, res: Response) => {
    const action = req.params.action as K8sUeScriptAction;
    if (!VALID_UE_SCRIPT_ACTIONS.includes(action)) {
      res.status(400).json({ success: false, error: `Invalid UE action: ${action}` });
      return;
    }

    const requested = req.body?.imsis ?? req.body?.imsi;
    const imsis =
      requested === undefined || requested === null
        ? []
        : Array.isArray(requested)
          ? requested
          : [requested];

    if (!imsis.every((value: unknown) => typeof value === 'string')) {
      res.status(400).json({ success: false, error: 'imsi must be a string, imsis an array of strings' });
      return;
    }
    if (imsis.length > MAX_UE_TARGETS) {
      res.status(400).json({
        success: false,
        error: `At most ${MAX_UE_TARGETS} UEs per call; name none to act on the whole batch`,
      });
      return;
    }

    try {
      const result = await k8sLabUseCase.runUeScript(action, imsis);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      //A malformed IMSI is the caller's mistake, not a server fault
      if (msg.startsWith('Not a UE identity')) {
        res.status(400).json({ success: false, error: msg });
        return;
      }
      logger.error({ err: msg, action, imsis }, 'Failed to execute UE script');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.get('/logs', async (_req: Request, res: Response) => {
    try {
      const files = await k8sLabUseCase.listLogFiles();
      res.json({ success: true, data: files });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'Failed to list K8s lab logs');
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.get('/logs/:name', async (req: Request, res: Response) => {
    const tail = parseInt(req.query.tail as string, 10) || 200;

    try {
      const logFile = await k8sLabUseCase.readLog(req.params.name, tail);
      res.json({ success: true, data: logFile });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, name: req.params.name }, 'Failed to read K8s lab log');
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}
