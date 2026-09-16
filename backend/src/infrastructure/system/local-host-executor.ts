import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import pino from 'pino';
import {
  IHostExecutor,
  CommandResult,
  StreamHandlers,
  StreamHandle,
} from '../../domain/interfaces/host-executor';

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
//How the streaming wrapper reports the host process group it created
const PGID_MARKER = 'NMS_STREAM_PGID:';

export class LocalHostExecutor implements IHostExecutor {
  constructor(
    private readonly logger: pino.Logger,
    private readonly systemctlPath: string = '/usr/bin/systemctl',
  ) {}

  async executeCommand(
    command: string,
    args: string[],
    timeoutMs: number = 30000,
  ): Promise<CommandResult> {
    this.logger.debug({ command, args }, 'Executing command');

    try {
      const nsenterArgs = ['-t', '1', '-m', '-u', '-i', '-p', command, ...args];
      
      const { stdout, stderr } = await execFileAsync('nsenter', nsenterArgs, {
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        env: {
          ...process.env,
          DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket',
        },
      });

      this.logger.debug({ command, args, stdout, stderr }, 'Command executed successfully');
      return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number; signal?: string };
      this.logger.debug({ command, args, error: error.stderr || String(err) }, 'Command execution failed');
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || String(err),
        exitCode: error.code || 1,
      };
    }
  }

  // Run a command locally inside the container (no nsenter) — used for
  // tools like mongodump/mongorestore that connect over the network and
  // must write to container-mounted volumes, not the host filesystem.
  async executeLocalCommand(
    command: string,
    args: string[],
    timeoutMs: number = 120000,
  ): Promise<CommandResult> {
    this.logger.debug({ command, args }, 'Executing local command');

    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      });

      this.logger.debug({ command, args, stdout, stderr }, 'Local command executed successfully');
      return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number; signal?: string };
      this.logger.error({ command, args, error: error.stderr || String(err) }, 'Local command execution failed');
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || String(err),
        exitCode: error.code || 1,
      };
    }
  }

  async readFile(filePath: string): Promise<string> {
    this.logger.debug({ filePath }, 'Reading file');
    return fs.readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, filePath);
    this.logger.debug({ filePath }, 'File written atomically');
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async copyFile(source: string, destination: string): Promise<void> {
    await fs.copyFile(source, destination);
  }

  async createDirectory(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async listDirectory(dirPath: string): Promise<string[]> {
    return fs.readdir(dirPath);
  }

  async restartService(unitName: string): Promise<CommandResult> {
    this.logger.info({ unitName }, 'Restarting service');
    return this.executeCommand(this.systemctlPath, ['restart', unitName]);
  }

  async startService(unitName: string): Promise<CommandResult> {
    this.logger.info({ unitName }, 'Starting service');
    return this.executeCommand(this.systemctlPath, ['start', unitName]);
  }

  async stopService(unitName: string): Promise<CommandResult> {
    this.logger.info({ unitName }, 'Stopping service');
    return this.executeCommand(this.systemctlPath, ['stop', unitName]);
  }

  async enableService(unitName: string): Promise<CommandResult> {
    this.logger.info({ unitName }, 'Enabling service at boot');
    return this.executeCommand(this.systemctlPath, ['enable', unitName]);
  }

  async disableService(unitName: string): Promise<CommandResult> {
    this.logger.info({ unitName }, 'Disabling service at boot');
    return this.executeCommand(this.systemctlPath, ['disable', unitName]);
  }

  async getServiceStatus(unitName: string): Promise<CommandResult> {
    return this.executeCommand(this.systemctlPath, ['status', unitName, '--no-pager']);
  }

  async isServiceActive(unitName: string): Promise<boolean> {
    const result = await this.executeCommand(this.systemctlPath, ['is-active', unitName]);
    return result.stdout.trim() === 'active';
  }

  async isServiceEnabled(unitName: string): Promise<boolean> {
    const result = await this.executeCommand(this.systemctlPath, ['is-enabled', unitName]);
    return result.stdout.trim() === 'enabled';
  }

  async isPortListening(port: number): Promise<boolean> {
    const result = await this.executeCommand('ss', ['-tlnp', `sport = :${port}`]);
    return result.stdout.includes(`:${port}`);
  }

  streamCommand(
    command: string,
    args: string[],
    handlers: StreamHandlers,
    timeoutMs: number = 300000,
  ): StreamHandle {
    this.logger.debug({ command, args }, 'Streaming command');

    //Same namespace hop executeCommand makes, so the command resolves against the
    //host's filesystem rather than this container's.
    //
    //setsid plus the reporting wrapper is what makes this stoppable. nsenter -p
    //puts the real work in the host's PID namespace, so killing the nsenter we
    //spawned leaves its descendants running and still holding the pipe: output
    //keeps arriving and the command never ends. Instead the wrapper starts a new
    //session, prints its own pid — which is that session's process group — and
    //kill() signals the whole group over in the host namespace.
    const child = spawn(
      'nsenter',
      [
        '-t', '1', '-m', '-u', '-i', '-p',
        'setsid',
        '/bin/bash', '-c', `echo "${PGID_MARKER}$$" >&2; exec "$@"`, 'nms-stream',
        command, ...args,
      ],
      {
        env: {
          ...process.env,
          DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/var/run/dbus/system_bus_socket',
        },
      },
    );

    let hostPgid: number | null = null;
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      handlers.onClose(exitCode, signal);
    };

    //A stream nobody stops must still end, or a forgotten window leaves a process
    //pinging for as long as the backend runs
    const timer = setTimeout(() => {
      handlers.onStderr(`\n[timed out after ${Math.round(timeoutMs / 1000)}s, stopping]\n`);
      this.killHostGroup(hostPgid);
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => handlers.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      //The wrapper's own line is plumbing, not output the caller asked for
      const kept: string[] = [];
      for (const line of chunk.split('\n')) {
        const marker = line.indexOf(PGID_MARKER);
        if (marker !== -1) {
          const parsed = Number.parseInt(line.slice(marker + PGID_MARKER.length).trim(), 10);
          if (Number.isInteger(parsed) && parsed > 1) {
            hostPgid = parsed;
          }
          continue;
        }
        kept.push(line);
      }
      const rest = kept.join('\n');
      if (rest.trim().length > 0) {
        handlers.onStderr(rest);
      }
    });

    child.on('error', (err) => {
      this.logger.error({ command, args, err: String(err) }, 'Streamed command failed to start');
      handlers.onStderr(String(err));
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));

    return {
      kill: () => {
        clearTimeout(timer);
        this.killHostGroup(hostPgid);
        try {
          child.kill('SIGTERM');
        } catch (err) {
          this.logger.warn({ err: String(err) }, 'Failed to stop streamed command');
        }
      },
    };
  }

  /**
   * Signals a process group in the host's PID namespace. The group holds the shell
   * and everything it started, so this is what actually ends a streamed run.
   */
  private killHostGroup(pgid: number | null): void {
    if (!pgid) {
      return;
    }
    try {
      //Enter the host PID namespace to address the group, then give it a moment
      //before SIGKILL for anything that ignored the first signal
      spawn('nsenter', [
        '-t', '1', '-m', '-u', '-i', '-p',
        '/bin/bash', '-c', `kill -TERM -${pgid} 2>/dev/null; sleep 2; kill -KILL -${pgid} 2>/dev/null`,
      ], { detached: true, stdio: 'ignore' }).unref();
    } catch (err) {
      this.logger.warn({ pgid, err: String(err) }, 'Failed to signal host process group');
    }
  }
}
