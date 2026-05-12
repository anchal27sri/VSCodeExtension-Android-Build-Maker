import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getOutputChannel } from './buildAndroid';

export interface AdbDevice {
    serial: string;
    state: string;
    model?: string;
    product?: string;
    device?: string;
    transportId?: string;
}

/**
 * Locates the adb binary. Priority:
 *   1. androidRunner.adbPath setting
 *   2. ANDROID_HOME / ANDROID_SDK_ROOT  /platform-tools/adb
 *   3. plain "adb" (resolved via PATH)
 */
export function findAdb(): string {
    const cfg = vscode.workspace.getConfiguration('androidRunner');
    const fromSetting = cfg.get<string>('adbPath', '').trim();
    if (fromSetting && fs.existsSync(fromSetting)) {
        return fromSetting;
    }

    const isWindows = process.platform === 'win32';
    const exe = isWindows ? 'adb.exe' : 'adb';
    const sdkRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean) as string[];
    for (const root of sdkRoots) {
        const candidate = path.join(root, 'platform-tools', exe);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return exe; // rely on PATH
}

/**
 * Run an adb command, capturing stdout. Throws on non-zero exit.
 */
function runAdbCapture(adb: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        cp.execFile(adb, args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`adb ${args.join(' ')} failed: ${stderr || err.message}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

/**
 * Run an adb command, streaming output to the Android Runner output channel.
 */
function runAdbStreaming(adb: string, args: string[]): Promise<void> {
    const out = getOutputChannel();
    return new Promise((resolve, reject) => {
        out.appendLine(`[adb] ${args.join(' ')}`);
        const child = cp.spawn(adb, args, { shell: false, env: process.env });
        child.stdout.on('data', (d: Buffer) => {
            for (const line of d.toString().split(/\r?\n/)) {
                if (line.length > 0) { out.appendLine(line); }
            }
        });
        child.stderr.on('data', (d: Buffer) => {
            for (const line of d.toString().split(/\r?\n/)) {
                if (line.length > 0) { out.appendLine(line); }
            }
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) { resolve(); }
            else { reject(new Error(`adb ${args[0]} exited with code ${code}`)); }
        });
    });
}

/**
 * Parse `adb devices -l` output into structured records.
 */
function parseDevices(stdout: string): AdbDevice[] {
    const devices: AdbDevice[] = [];
    const lines = stdout.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('List of devices')) { continue; }
        if (line.startsWith('*')) { continue; } // daemon startup messages
        const parts = line.split(/\s+/);
        if (parts.length < 2) { continue; }
        const [serial, state, ...rest] = parts;
        const dev: AdbDevice = { serial, state };
        for (const kv of rest) {
            const idx = kv.indexOf(':');
            if (idx > 0) {
                const k = kv.substring(0, idx);
                const v = kv.substring(idx + 1);
                if (k === 'model') { dev.model = v; }
                else if (k === 'product') { dev.product = v; }
                else if (k === 'device') { dev.device = v; }
                else if (k === 'transport_id') { dev.transportId = v; }
            }
        }
        devices.push(dev);
    }
    return devices;
}

export async function listDevices(): Promise<AdbDevice[]> {
    const adb = findAdb();
    const stdout = await runAdbCapture(adb, ['devices', '-l']);
    return parseDevices(stdout);
}

/**
 * Always prompts the user with a QuickPick of online devices. Re-lists on
 * "Refresh". Returns undefined if the user cancels.
 */
export async function pickDevice(): Promise<AdbDevice | undefined> {
    const REFRESH_LABEL = '$(refresh) Refresh device list';

    while (true) {
        let devices: AdbDevice[] = [];
        try {
            devices = (await listDevices()).filter(d => d.state === 'device');
        } catch (err: any) {
            const choice = await vscode.window.showErrorMessage(
                `Could not list adb devices: ${err.message}`,
                'Retry', 'Open Logs', 'Cancel'
            );
            if (choice === 'Retry') { continue; }
            if (choice === 'Open Logs') { getOutputChannel().show(true); }
            return undefined;
        }

        type Item = vscode.QuickPickItem & { device?: AdbDevice; refresh?: boolean };
        const items: Item[] = devices.map(d => ({
            label: `$(device-mobile) ${d.model ?? d.product ?? d.serial}`,
            description: d.serial,
            detail: [d.product, d.device].filter(Boolean).join(' • ') || undefined,
            device: d
        }));
        items.push({ label: REFRESH_LABEL, refresh: true });

        const placeHolder = devices.length === 0
            ? 'No connected devices. Plug in a device or start an emulator, then Refresh.'
            : 'Select a device to install on';

        const pick = await vscode.window.showQuickPick(items, { placeHolder });
        if (!pick) { return undefined; }
        if (pick.refresh) { continue; }
        return pick.device;
    }
}

export async function install(serial: string, apkPath: string): Promise<void> {
    const adb = findAdb();
    await runAdbStreaming(adb, ['-s', serial, 'install', '-r', '-t', apkPath]);
}

export async function launch(serial: string, packageId: string, activity: string): Promise<void> {
    const adb = findAdb();
    const component = activity.includes('/')
        ? activity
        : `${packageId}/${activity.startsWith('.') ? packageId + activity : activity}`;
    await runAdbStreaming(adb, ['-s', serial, 'shell', 'am', 'start', '-n', component]);
}

/**
 * Fallback launch using monkey when we cannot identify the launcher activity.
 */
export async function launchViaMonkey(serial: string, packageId: string): Promise<void> {
    const adb = findAdb();
    await runAdbStreaming(adb, [
        '-s', serial, 'shell', 'monkey',
        '-p', packageId,
        '-c', 'android.intent.category.LAUNCHER',
        '1'
    ]);
}
