export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Callbacks for a command whose output is consumed as it is produced. */
export interface StreamHandlers {
  onStdout(chunk: string): void;
  onStderr(chunk: string): void;
  onClose(exitCode: number | null, signal: string | null): void;
}

/** Handle on a running streamed command, so a caller can stop it early. */
export interface StreamHandle {
  kill(): void;
}

export interface IHostExecutor {
  executeCommand(command: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
  executeLocalCommand(command: string, args: string[], timeoutMs?: number): Promise<CommandResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  copyFile(source: string, destination: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  listDirectory(path: string): Promise<string[]>;
  restartService(unitName: string): Promise<CommandResult>;
  startService(unitName: string): Promise<CommandResult>;
  stopService(unitName: string): Promise<CommandResult>;
  getServiceStatus(unitName: string): Promise<CommandResult>;
  isServiceActive(unitName: string): Promise<boolean>;
  isServiceEnabled(unitName: string): Promise<boolean>;
  enableService(unitName: string): Promise<CommandResult>;
  disableService(unitName: string): Promise<CommandResult>;
  isPortListening(port: number): Promise<boolean>;
  /**
   * Runs a host command and hands output to the callbacks as it arrives, rather
   * than buffering it until exit. For output a user watches live, such as a UE's
   * pings, where waiting for the command to finish defeats the point.
   */
  streamCommand(
    command: string,
    args: string[],
    handlers: StreamHandlers,
    timeoutMs?: number,
  ): StreamHandle;
}
