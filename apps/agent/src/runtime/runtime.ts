import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AgentCommand,
  AgentInstance,
  InstanceReport,
  Json,
  Player,
  StartupProgress,
} from '@ark-control/common';
import { effectiveGameConfig } from '@ark-control/common';
import type { AgentConfig } from '@/config';
import type { AgentClient } from '@/client';
import type { FileLibrary } from '@/server-files';
import { atomicJson, inside, readJson } from '@/files';
import { rcon } from '@/rcon';
import { redactText } from '@/privacy';
import { checkIndependentShop } from '@/management';
import { createBackup, restoreBackup } from '@/backups';
import { delay, forceStop, pidInUse, processMatches, processMetrics } from '@/runtime/processes';
import { exists, installServer, serverExecutable, updateMods } from '@/runtime/install';
import { launchArguments, writeSettings } from '@/runtime/settings';
import { removeManagedInstance } from '@/runtime/cleanup';
import { PluginRuntime } from '@/server-plugins';
import {
  STARTUP_TIMEOUT_MS,
  StartupLogReader,
  redactStartupText,
  startupLogPaths,
} from '@/runtime/startup';

interface ProcessState {
  pid: number | null;
  startedAt: string | null;
  lastError: string | null;
  verifiedClusterAdminRevision?: string;
  starting?: boolean;
  startup?: StartupProgress | null;
}
export class GameRuntime {
  private state: Record<string, ProcessState> = {};
  private readonly statuses = new Map<string, InstanceReport['status']>();
  private pendingPersist: Promise<void> = Promise.resolve();
  private steamWork: Promise<void> = Promise.resolve();
  private readonly starting = new Set<string>();
  private readonly startupReaders = new Map<string, StartupLogReader>();
  private readonly plugins: PluginRuntime;
  constructor(
    readonly config: AgentConfig,
    private readonly client: AgentClient,
    private readonly log: (
      instanceId: string,
      text: string,
      level?: 'info' | 'warn' | 'error',
    ) => void,
    private readonly files?: FileLibrary,
    private readonly maskLaunchPassword?: (instanceId: string, password: string) => void,
  ) {
    this.plugins = new PluginRuntime(config.root, client, files);
  }
  async initialize() {
    await mkdir(this.config.root, { recursive: true });
    this.state = await readJson(inside(this.config.root, 'processes.json'), {});
  }
  private persist() {
    this.pendingPersist = this.pendingPersist
      .catch(() => undefined)
      .then(() => atomicJson(inside(this.config.root, 'processes.json'), this.state));
    return this.pendingPersist;
  }
  private async withSteamLock(operation: () => Promise<void>, signal: AbortSignal) {
    if (this.files) return this.files.steam(operation, signal);
    const previous = this.steamWork;
    let release!: () => void;
    this.steamWork = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      signal.throwIfAborted();
      await operation();
    } finally {
      release();
    }
  }
  private async alive(instance: AgentInstance) {
    const pid = this.state[instance.id]?.pid;
    return !!pid && (await processMatches(pid, serverExecutable(this.config.root, instance.id)));
  }
  private async startupLogs(instance: AgentInstance) {
    const progress = this.state[instance.id]?.startup;
    if (!progress) return;
    let reader = this.startupReaders.get(instance.id);
    if (!reader) {
      reader = new StartupLogReader(progress.logPaths, [
        instance.rconPassword,
        instance.config.serverPassword,
      ]);
      this.startupReaders.set(instance.id, reader);
    }
    const lines = await reader.collect().catch(() => []);
    if (lines.length) {
      progress.logs = [...progress.logs, ...lines].slice(-10);
      progress.logUpdatedAt = new Date().toISOString();
      for (const line of lines) this.log(instance.id, line);
    }
  }
  private async checkStartup(instance: AgentInstance) {
    const state = this.state[instance.id]!;
    const progress = state.startup!;
    await this.startupLogs(instance);
    try {
      if (instance.credentialError) throw new Error(instance.credentialError);
      await rcon(instance.rconPort, instance.rconPassword, 'ListPlayers', 3000);
      progress.stage = 'ready';
      progress.rconReady = true;
      state.verifiedClusterAdminRevision = instance.clusterAdminRevision;
      progress.lastRconError = null;
      progress.message = '启动检测通过，RCON 已响应，可以尝试进服。';
      state.starting = false;
      state.lastError = null;
      this.statuses.set(instance.id, 'running');
    } catch (error) {
      progress.lastRconError = redactStartupText(
        error instanceof Error ? error.message : '检测失败',
        [instance.rconPassword, instance.config.serverPassword],
      );
      progress.message = '游戏进程存在，正在等待地图加载及 RCON 响应。';
    }
    progress.updatedAt = new Date().toISOString();
    return progress.rconReady;
  }
  async reports(instances: AgentInstance[]): Promise<InstanceReport[]> {
    const reports: InstanceReport[] = [];
    for (const instance of instances) {
      const process = this.state[instance.id];
      const alive = await this.alive(instance);
      if (alive && process?.starting && !this.starting.has(instance.id)) {
        process.startup ??= {
          stage: 'loading',
          startedAt: process.startedAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: '助手恢复连接，重新核对地图是否就绪。',
          rconReady: false,
          lastRconError: null,
          logUpdatedAt: null,
          logPaths: startupLogPaths(this.config.root, instance.id),
          logs: [],
        };
        if (
          !(await this.checkStartup(instance)) &&
          Date.now() - Date.parse(process.startup.startedAt) >= STARTUP_TIMEOUT_MS
        ) {
          process.starting = false;
          process.startup.stage = 'failed';
          process.lastError =
            '启动等待超过 30 分钟，RCON 未就绪。进程仍保留，请查看启动日志或停止地图。' +
            (process.startup.lastRconError
              ? `\n最后检测错误：${process.startup.lastRconError}`
              : '');
          process.startup.message = process.lastError;
          this.statuses.set(instance.id, 'error');
        }
        await this.persist();
      }
      if (!alive && process?.starting && !this.starting.has(instance.id)) {
        await this.startupLogs(instance);
        process.starting = false;
        process.lastError = '游戏在启动期间退出，请检查启动日志。';
        if (process.startup) {
          process.startup.stage = 'failed';
          process.startup.message = process.lastError;
          process.startup.updatedAt = new Date().toISOString();
        }
        this.statuses.set(instance.id, 'error');
        await this.persist();
      }
      const metrics =
        alive && process?.pid ? await processMetrics(process.pid) : { cpuPercent: 0, memoryMb: 0 };
      let status =
        this.statuses.get(instance.id) ??
        (process?.starting
          ? 'starting'
          : process?.startup?.stage === 'failed' && alive
            ? 'error'
            : alive
              ? 'running'
              : process?.pid
                ? 'error'
                : 'stopped');
      if (!alive && ['running', 'starting'].includes(status) && !this.starting.has(instance.id))
        status = 'error';
      if (alive && process?.starting && status === 'running') status = 'starting';
      const installation = this.files
        ? await this.files.installation(instance)
        : {
            installed: await exists(serverExecutable(this.config.root, instance.id)),
            buildId: null,
          };
      reports.push({
        id: instance.id,
        status,
        ...installation,
        ...metrics,
        pid: alive ? (process?.pid ?? null) : null,
        startedAt: alive ? (process?.startedAt ?? null) : null,
        lastError:
          process?.lastError ??
          instance.credentialError ??
          (!alive && process?.pid ? '游戏进程已退出，请查看运行日志。' : null),
        startup: process?.startup ?? null,
        verifiedClusterAdminRevision: alive ? process?.verifiedClusterAdminRevision : undefined,
        plugins: installation.installed ? this.plugins.current(instance.id) : undefined,
      });
    }
    this.plugins.refresh(reports);
    return reports;
  }
  private async start(
    instance: AgentInstance,
    commandId: string,
    signal: AbortSignal,
    report: (text: string) => void,
  ) {
    if (instance.credentialError) throw new Error(instance.credentialError);
    signal.throwIfAborted();
    if (await this.alive(instance)) throw new Error('地图进程已经在运行。');
    const pid = this.state[instance.id]?.pid;
    if (instance.useClusterAdminPassword && pid && pidInUse(pid))
      throw new Error('未确认旧游戏进程已退出，暂不能应用互通组密码。');
    this.starting.add(instance.id);
    const startedAt = new Date().toISOString();
    this.state[instance.id] = {
      pid: null,
      startedAt,
      lastError: null,
      starting: true,
      startup: {
        stage: 'preparing',
        startedAt,
        updatedAt: startedAt,
        message: '正在检查配置和服务端文件。',
        rconReady: false,
        lastRconError: null,
        logUpdatedAt: null,
        logPaths: startupLogPaths(this.config.root, instance.id),
        logs: [],
      },
    };
    this.statuses.set(instance.id, 'starting');
    report('正在检查配置和服务端文件。');
    await checkIndependentShop(this.config.root, instance);
    if (this.files) await this.files.prepareLaunch(instance, report, signal);
    const executable = serverExecutable(this.config.root, instance.id);
    if (!(await exists(executable))) throw new Error('服务端程序不存在，请先安装。');
    if (instance.useClusterAdminPassword) {
      signal.throwIfAborted();
      const credential = await this.client.request<{ rconPassword: string; revision: string }>(
        `/commands/${commandId}/launch-credential`,
        {},
      );
      instance.rconPassword = credential.rconPassword;
      instance.clusterAdminRevision = credential.revision;
      this.maskLaunchPassword?.(instance.id, credential.rconPassword);
      signal.throwIfAborted();
    }
    const progress = this.state[instance.id]!.startup!;
    const reader = new StartupLogReader(progress.logPaths, [
      instance.rconPassword,
      instance.config.serverPassword,
    ]);
    this.startupReaders.set(instance.id, reader);
    await reader.begin();
    await writeSettings(this.config.root, instance);
    const applied = effectiveGameConfig(instance.config);
    report(
      `已写入游戏配置：经验 ${applied.xp}×，采集 ${applied.harvest}×，驯服 ${applied.taming}×，${applied.pve ? 'PVE' : 'PVP'}。`,
    );
    const args = await launchArguments(this.config.root, this.config.clusterRoot, instance);
    this.statuses.set(instance.id, 'starting');
    progress.stage = 'launching';
    progress.message = '正在创建游戏进程。';
    report(progress.message);
    const logDirectory = inside(
      this.config.root,
      'instances',
      instance.id,
      'ShooterGame',
      'Saved',
      'Logs',
    );
    await mkdir(logDirectory, { recursive: true });
    signal.throwIfAborted();
    const outputFile = openSync(inside(logDirectory, 'ArkControlProcess.log'), 'a', 0o600);
    let child;
    try {
      child = spawn(executable, args, {
        shell: false,
        windowsHide: true,
        detached: true,
        cwd: dirname(executable),
        stdio: ['ignore', outputFile, outputFile],
      });
    } finally {
      closeSync(outputFile);
    }
    let spawnError: Error | undefined;
    let exitDescription = '';
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('exit', (code, signal) => {
      exitDescription = code === null ? `（信号 ${signal ?? '未知'}）` : `（退出码 ${code}）`;
    });
    await delay(300);
    if (spawnError || !child.pid) throw new Error(spawnError?.message ?? '地图进程创建失败。');
    this.state[instance.id]!.pid = child.pid;
    progress.stage = 'loading';
    progress.message = '游戏进程已创建，正在等待地图加载及 RCON 响应。';
    report(
      `游戏进程已创建（PID ${child.pid}），启动参数采集倍率 ${applied.harvest}×，等待 RCON ${instance.rconPort} 就绪。`,
    );
    await this.persist();
    child.unref();
    const deadline = Date.parse(startedAt) + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (!(await this.alive(instance))) {
        await this.startupLogs(instance);
        throw new Error(`游戏在启动期间退出${exitDescription}，请检查运行库、模组和启动日志。`);
      }
      const ready = await this.checkStartup(instance);
      signal.throwIfAborted();
      if (ready) {
        report(progress.message);
        await this.persist();
        this.starting.delete(instance.id);
        return;
      }
      report(
        `已等待 ${Math.floor((Date.now() - Date.parse(startedAt)) / 1000)} 秒；进程 PID ${child.pid} 存在，RCON ${instance.rconPort} 尚未就绪。${progress.lastRconError ?? ''}`,
      );
      await this.persist();
      await delay(3000, signal);
    }
    throw new Error(
      '启动等待超过 30 分钟，RCON 未就绪。进程仍保留，请查看启动日志或停止地图。' +
        (progress.lastRconError ? `\n最后检测错误：${progress.lastRconError}` : ''),
    );
  }
  private async stop(
    instance: AgentInstance,
    countdownSeconds: number,
    signal: AbortSignal,
    report: (text: string) => void,
    commandId?: string,
  ) {
    const pid = this.state[instance.id]?.pid;
    if (!(await this.alive(instance))) {
      if (instance.useClusterAdminPassword && pid && pidInUse(pid))
        throw new Error('未确认旧游戏进程已退出。');
      if (commandId) {
        const commit = await this.client.request<{ cancelled: boolean }>(
          `/commands/${commandId}/commit-stop`,
          {},
        );
        if (commit.cancelled) throw new DOMException('倒计时已取消。', 'AbortError');
      }
      this.state[instance.id] = { pid: null, startedAt: null, lastError: null };
      this.statuses.set(instance.id, 'stopped');
      await this.persist();
      return;
    }
    if (instance.credentialError) throw new Error(instance.credentialError);
    const deadline = Date.now() + countdownSeconds * 1000;
    let announced = -1;
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('倒计时已取消。');
      const left = Math.ceil((deadline - Date.now()) / 1000);
      if (announced === -1 || left <= 5 || left % 10 === 0) {
        if (announced !== left) {
          report(`停服倒计时：${left} 秒，可取消。`);
          await rcon(
            instance.rconPort,
            instance.rconPassword,
            `Broadcast Server maintenance in ${left} seconds`,
          ).catch(() => undefined);
          announced = left;
        }
      }
      await delay(500, signal);
    }
    if (signal.aborted) throw new Error('倒计时已取消。');
    const commit = commandId
      ? await this.client.request<{ cancelled: boolean }>(`/commands/${commandId}/commit-stop`, {})
      : { cancelled: false };
    if (commit.cancelled) throw new DOMException('倒计时已取消。', 'AbortError');
    report('正在保存世界。');
    try {
      await rcon(instance.rconPort, instance.rconPassword, 'SaveWorld');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'RCON 不可用。';
      throw new Error(
        `RCON 保存世界失败，正常关闭流程已中止。配置文件的写入状态可在「游戏配置」查看。\n${detail}\n请先修复 RCON。如果可以接受丢失尚未保存的进度，可使用「强制关闭」后再启动地图。`,
      );
    }
    await delay(3000);
    this.statuses.set(instance.id, 'stopping');
    report('已请求正常退出，等待进程结束。');
    await rcon(instance.rconPort, instance.rconPassword, 'DoExit').catch(() => undefined);
    const limit = Date.now() + 120000;
    while (Date.now() < limit && (await this.alive(instance))) await delay(1000);
    if ((await this.alive(instance)) || (instance.useClusterAdminPassword && pid && pidInUse(pid)))
      throw new Error('正常停服超过两分钟，未强制结束；请核对后使用强制停止。');
    this.state[instance.id] = { pid: null, startedAt: null, lastError: null };
    this.statuses.set(instance.id, 'stopped');
    await this.persist();
  }
  async disconnect(instances: AgentInstance[]) {
    const errors: string[] = [];
    for (const instance of instances) {
      try {
        await this.stop(instance, 0, new AbortController().signal, (text) =>
          this.log(instance.id, text),
        );
      } catch (error) {
        errors.push(`${instance.name}：${error instanceof Error ? error.message : '关闭失败'}`);
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
  }
  async execute(
    command: AgentCommand,
    signal: AbortSignal,
    report: (text: string) => void,
  ): Promise<Record<string, Json>> {
    const instance = command.instance;
    const root = this.config.root;
    const output = (text: string) => {
      this.log(instance.id, text);
      report(text);
    };
    try {
      await this.files?.waitForScan();
      if (
        this.files?.isBusy(instance.id) &&
        [
          'install',
          'update',
          'start',
          'restart',
          'restore',
          'mods-update',
          'delete',
          'sync-config',
          'install-plugins',
        ].includes(command.kind)
      )
        throw new Error('此地图的服务端文件正在操作，请等待文件任务完成。');
      if (
        instance.credentialError &&
        !['install', 'install-plugins', 'stop', 'force-stop', 'delete'].includes(command.kind)
      )
        throw new Error(instance.credentialError);
      switch (command.kind) {
        case 'install-plugins': {
          if (await this.alive(instance)) throw new Error('请先停止地图。');
          const installed = this.files
            ? (await this.files.installation(instance)).installed
            : await exists(serverExecutable(root, instance.id));
          if (!installed) throw new Error('此地图的游戏服务端文件不存在，请先安装地图。');
          return await this.plugins.install(command, signal, output);
        }
        case 'sync-config': {
          signal.throwIfAborted();
          const receipt = await writeSettings(root, instance);
          output(
            `已写入并回读两份 INI。采集倍率 ${receipt.harvest ?? '未指定有效数值'}。游戏在下次启动时读取。`,
          );
          return receipt;
        }
        case 'install':
        case 'update': {
          const update = command.kind === 'update';
          const alive = await this.alive(instance);
          const resume = update && command.payload.maintenance === true && alive;
          if (alive && !resume) throw new Error('请先停止地图。');
          const stopForUpdate = () =>
            this.stop(
              instance,
              Number(command.payload.countdownSeconds ?? 30),
              signal,
              output,
              command.id,
            );
          // Legacy processes must stop before their original install can be moved to maps.
          const shared = await this.files?.installation(instance);
          if (resume && !shared?.serverFileId) await stopForUpdate();
          this.statuses.set(instance.id, update ? 'updating' : 'installing');
          const logFile = inside(root, 'logs', 'steamcmd', `${command.id}.log`);
          const beforeUpdate = async (members: AgentInstance[]) => {
            if (resume && shared?.serverFileId) await stopForUpdate();
            this.statuses.set(instance.id, 'updating');
            for (const member of members) {
              signal.throwIfAborted();
              if (await exists(inside(root, 'instances', member.id, 'ShooterGame', 'Saved'))) {
                output(`正在备份「${member.name}」的存档。`);
                await createBackup(root, member, command.id, this.client, output);
              }
            }
          };
          let result: { reused: boolean; fileId?: string } = { reused: false };
          if (this.files)
            result = await this.files.prepare(
              instance,
              { update, logFile, beforeUpdate: update ? beforeUpdate : undefined },
              output,
              signal,
            );
          else {
            if (update) await beforeUpdate([instance]);
            await this.withSteamLock(
              () => installServer(root, instance, output, signal, logFile),
              signal,
            );
          }
          this.state[instance.id] = { pid: null, startedAt: null, lastError: null };
          await this.persist();
          this.statuses.set(instance.id, 'stopped');
          if (resume) await this.start(instance, command.id, signal, output);
          return { installed: true, resumed: resume, ...result };
        }
        case 'start':
          await this.start(instance, command.id, signal, output);
          return { started: true };
        case 'stop':
          await this.stop(
            instance,
            Number(command.payload.countdownSeconds ?? 30),
            signal,
            output,
            command.id,
          );
          return { stopped: true };
        case 'restart':
          await this.stop(
            instance,
            Number(command.payload.countdownSeconds ?? 30),
            signal,
            output,
            command.id,
          );
          await this.start(instance, command.id, signal, output);
          return { restarted: true };
        case 'delete': {
          await this.stop(
            instance,
            Number(command.payload.countdownSeconds ?? 30),
            signal,
            output,
            command.id,
          );
          signal.throwIfAborted();
          this.statuses.set(instance.id, 'deleting');
          output('地图已关闭，正在回收存档，已下载的服务端文件将保留在文件库。');
          const result = this.files
            ? await this.files.removeMap(instance, command.id)
            : await removeManagedInstance(root, instance.id, command.id);
          output('已下载文件已保留，正在更新文件索引。');
          delete this.state[instance.id];
          this.statuses.delete(instance.id);
          this.startupReaders.delete(instance.id);
          await this.persist();
          if (result.savedArchive) output(`存档已保留到：${result.savedArchive}`);
          return { deleted: true, ...result };
        }
        case 'force-stop': {
          const pid = this.state[instance.id]?.pid;
          if (pid && pidInUse(pid)) {
            if (!(await this.alive(instance)) && pidInUse(pid))
              throw new Error('无法核对记录中的游戏进程身份，请查看游戏主机。');
            try {
              await forceStop(pid, serverExecutable(root, instance.id));
            } catch (error) {
              if (pidInUse(pid)) throw error;
            }
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline && pidInUse(pid)) await delay(250);
            if (pidInUse(pid)) throw new Error('尚未确认游戏进程退出，请重新尝试。');
          }
          this.state[instance.id] = { pid: null, startedAt: null, lastError: null };
          this.statuses.set(instance.id, 'stopped');
          this.startupReaders.delete(instance.id);
          await this.persist();
          return { stopped: true };
        }
        case 'save':
          await rcon(instance.rconPort, instance.rconPassword, 'SaveWorld');
          return { saved: true };
        case 'broadcast':
          await rcon(
            instance.rconPort,
            instance.rconPassword,
            `Broadcast ${String(command.payload.message).replace(/[\r\n]/g, ' ')}`,
          );
          return { announced: true };
        case 'kick':
        case 'ban':
        case 'unban': {
          const id = String(command.payload.playerId);
          if (!/^\d{1,24}$/.test(id)) throw new Error('玩家 ID 格式错误。');
          const action = { kick: 'KickPlayer', ban: 'BanPlayer', unban: 'UnBanPlayer' }[
            command.kind
          ];
          await rcon(instance.rconPort, instance.rconPassword, `${action} ${id}`);
          return { completed: true };
        }
        case 'players': {
          const text = await rcon(instance.rconPort, instance.rconPassword, 'ListPlayers');
          const players: Player[] = text
            .split('\n')
            .map((line) => line.match(/^\s*(\d+)\.\s*(.+),\s*(\d{10,24})\s*$/))
            .filter((match): match is RegExpMatchArray => !!match)
            .map((match) => ({ id: match[1]!, name: match[2]!, steamId: match[3]! }));
          return { players: players.map((player) => ({ ...player })), raw: text };
        }
        case 'backup': {
          if (await this.alive(instance)) {
            await rcon(instance.rconPort, instance.rconPassword, 'SaveWorld');
            await delay(3000);
          }
          const backup = await createBackup(root, instance, command.id, this.client, output);
          return { backupId: backup.backupId, sha256: backup.sha256 };
        }
        case 'restore': {
          if (await this.alive(instance)) throw new Error('恢复前必须停止地图。');
          this.statuses.set(instance.id, 'restoring');
          await restoreBackup(
            root,
            instance,
            command.id,
            String(command.payload.backupId),
            this.client,
            output,
          );
          this.statuses.set(instance.id, 'stopped');
          return { restored: true };
        }
        case 'mods-update': {
          if (await this.alive(instance)) throw new Error('更新模组前必须停止地图。');
          await writeSettings(root, instance);
          await this.withSteamLock(
            () =>
              updateMods(
                root,
                instance,
                output,
                signal,
                inside(root, 'logs', 'steamcmd', `${command.id}.log`),
              ),
            signal,
          );
          if (this.state[instance.id]) this.state[instance.id]!.lastError = null;
          await this.persist();
          return { downloaded: true, requiresStartupValidation: true };
        }
      }
    } catch (error) {
      // A failed INI write is a task failure, independent of the game process lifecycle.
      if (['sync-config', 'install-plugins'].includes(command.kind)) throw error;
      const message = redactText(error instanceof Error ? error.message : '任务执行失败。', [
        instance.rconPassword,
        instance.config.serverPassword,
      ]);
      const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const state = this.state[instance.id] ?? { pid: null, startedAt: null, lastError: null };
      state.lastError = cancelled ? null : message;
      if (this.starting.delete(instance.id)) {
        state.starting = false;
        if (state.startup) {
          state.startup.stage = 'failed';
          state.startup.message = message;
          state.startup.updatedAt = new Date().toISOString();
        }
      }
      this.state[instance.id] = state;
      this.statuses.set(
        instance.id,
        state.startup?.stage === 'failed'
          ? 'error'
          : (await this.alive(instance))
            ? 'running'
            : cancelled || command.kind === 'stop'
              ? 'stopped'
              : 'error',
      );
      await this.persist();
      throw error;
    }
  }
}
