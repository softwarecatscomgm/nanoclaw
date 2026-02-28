/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 30000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    const errObj = err as {
      code?: string;
      status?: number;
      signal?: string;
      stderr?: Buffer;
      stdout?: Buffer;
    };
    const stderr = errObj.stderr?.toString().trim() || '';
    const stdout = errObj.stdout?.toString().trim() || '';

    // Gather environment diagnostics
    let whichDocker = '';
    let socketExists = false;
    try {
      whichDocker = execSync('which docker', {
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
    } catch {
      whichDocker = '<not found in PATH>';
    }
    try {
      socketExists = fs.existsSync('/var/run/docker.sock');
    } catch {
      /* ignore */
    }
    let dockerPs = '';
    try {
      dockerPs = execSync(`${CONTAINER_RUNTIME_BIN} ps --format '{{.Names}}: {{.Status}}'`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();
    } catch (psErr) {
      dockerPs = `<failed: ${(psErr as Error).message}>`;
    }

    logger.error(
      {
        errorCode: errObj.code,
        exitStatus: errObj.status,
        signal: errObj.signal,
        stderr,
        stdout: stdout.slice(0, 500),
        dockerBin: whichDocker,
        socketExists,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        DOCKER_HOST: process.env.DOCKER_HOST || '<unset>',
        DOCKER_CONTEXT: process.env.DOCKER_CONTEXT || '<unset>',
        dockerPs,
      },
      'Container runtime check failed',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
