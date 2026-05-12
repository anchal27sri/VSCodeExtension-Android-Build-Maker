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

export interface AdbUser {
    id: number;
    name: string;
    /** Raw flags hex from `pm list users`, when available. */
    flags?: string;
    running: boolean;
    /**
     * Heuristic classification derived from name + flags:
     *   - owner: user id 0
     *   - work:  managed profile (name typically "Work profile" or flags 0x20)
     *   - secondary: any other secondary user
     */
    kind: 'owner' | 'work' | 'secondary';
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
 * Resolves a single online adb device. Auto-selects when exactly one device
 * is connected; otherwise shows a QuickPick (with a Refresh entry).
 * Returns undefined if the user cancels.
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

        // Skip the picker when there's exactly one online device.
        if (devices.length === 1) {
            const d = devices[0];
            getOutputChannel().appendLine(
                `[Android Runner] Auto-selected the only connected device: ${d.model ?? d.product ?? d.serial} (${d.serial}).`
            );
            return d;
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

/**
 * Lists the Android users (profiles) on the given device by parsing
 * `adb shell pm list users`.
 *
 * Expected output looks like:
 *   Users:
 *     UserInfo{0:Owner:c13} running
 *     UserInfo{10:Work profile:30} running
 */
export async function listUsers(serial: string): Promise<AdbUser[]> {
    const adb = findAdb();
    const stdout = await runAdbCapture(adb, ['-s', serial, 'shell', 'pm', 'list', 'users']);
    const users: AdbUser[] = [];
    const re = /UserInfo\{(\d+):([^:}]*):?([0-9a-fA-F]*)\}\s*(running)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stdout)) !== null) {
        const id = parseInt(m[1], 10);
        const name = (m[2] || '').trim();
        const flags = m[3] || undefined;
        const running = !!m[4];
        let kind: AdbUser['kind'] = 'secondary';
        if (id === 0) {
            kind = 'owner';
        } else if (/work\s*profile/i.test(name) || (flags && (parseInt(flags, 16) & 0x20) !== 0)) {
            // 0x20 = FLAG_MANAGED_PROFILE on AOSP
            kind = 'work';
        }
        users.push({ id, name, flags, running, kind });
    }
    return users;
}

/**
 * Resolves the Android user profile to install into. Auto-selects when the
 * device only reports a single user; otherwise shows a QuickPick.
 * Returns undefined if the user cancels.
 */
export async function pickUser(serial: string): Promise<AdbUser | undefined> {
    let users: AdbUser[];
    try {
        users = await listUsers(serial);
    } catch (err: any) {
        const choice = await vscode.window.showErrorMessage(
            `Could not list user profiles on device: ${err.message}`,
            'Continue as default user', 'Cancel'
        );
        if (choice === 'Continue as default user') {
            return { id: 0, name: 'Owner', running: true, kind: 'owner' };
        }
        return undefined;
    }

    if (users.length === 0) {
        // Fall back silently; nothing to pick.
        return { id: 0, name: 'Owner', running: true, kind: 'owner' };
    }

    // Skip the picker when there's exactly one profile.
    if (users.length === 1) {
        const u = users[0];
        getOutputChannel().appendLine(
            `[Android Runner] Auto-selected the only profile on device: ${u.name || `user ${u.id}`} (id ${u.id}).`
        );
        return u;
    }

    const iconFor = (u: AdbUser) =>
        u.kind === 'work' ? '$(briefcase)' :
        u.kind === 'owner' ? '$(person)' :
        '$(account)';
    const detailFor = (u: AdbUser) => {
        const bits: string[] = [];
        bits.push(u.kind === 'work' ? 'work profile' :
                  u.kind === 'owner' ? 'primary user' : 'secondary user');
        if (!u.running) { bits.push('stopped'); }
        if (u.flags) { bits.push(`flags=0x${u.flags}`); }
        return bits.join(' • ');
    };

    type Item = vscode.QuickPickItem & { user: AdbUser };
    const items: Item[] = users.map(u => ({
        label: `${iconFor(u)} ${u.name || `User ${u.id}`}`,
        description: `user ${u.id}`,
        detail: detailFor(u),
        user: u
    }));

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select the Android profile to install the APK into',
        matchOnDetail: true
    });
    return pick?.user;
}

export async function install(serial: string, apkPath: string, userId?: number): Promise<void> {
    const adb = findAdb();
    const args = ['-s', serial, 'install', '-r', '-t'];
    if (typeof userId === 'number') {
        args.push('--user', String(userId));
    }
    args.push(apkPath);
    await runAdbStreaming(adb, args);
}

export async function launch(serial: string, packageId: string, activity: string, userId?: number): Promise<void> {
    const adb = findAdb();
    const component = activity.includes('/')
        ? activity
        : `${packageId}/${activity.startsWith('.') ? packageId + activity : activity}`;
    const args = ['-s', serial, 'shell', 'am', 'start'];
    if (typeof userId === 'number') {
        args.push('--user', String(userId));
    }
    args.push('-n', component);
    await runAdbStreaming(adb, args);
}

/**
 * Query the device to resolve the launcher activity for a package.
 * Tries `cmd package resolve-activity` (API 24+) first, then falls back
 * to parsing `dumpsys package`.
 */
async function resolveDeviceLauncherActivity(
    serial: string,
    packageId: string,
    userId?: number
): Promise<string | undefined> {
    const adb = findAdb();
    const out = getOutputChannel();

    // Attempt 1: cmd package resolve-activity --brief (API 28+)
    try {
        const resolveArgs = ['-s', serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief'];
        if (typeof userId === 'number') {
            resolveArgs.push('--user', String(userId));
        }
        resolveArgs.push('-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageId);
        const stdout = await runAdbCapture(adb, resolveArgs);
        // Output format: "priority=0 preferredOrder=0 ...\ncom.pkg/.Activity"
        const lines = stdout.trim().split(/\r?\n/).filter(l => l.includes('/'));
        if (lines.length > 0) {
            const component = lines[lines.length - 1].trim();
            if (component.includes('/')) {
                out.appendLine(`[Android Runner] Resolved launcher from device: ${component}`);
                return component;
            }
        }
    } catch {
        // Not supported on this API level; fall through
    }

    // Attempt 2: parse dumpsys package for MAIN/LAUNCHER activity
    try {
        const dumpArgs = ['-s', serial, 'shell', 'dumpsys', 'package', packageId];
        const stdout = await runAdbCapture(adb, dumpArgs);
        // Look for a MAIN/LAUNCHER intent filter in the activity resolver table
        // Pattern: "... <componentName>/ActivityName filter ..."
        // We search for lines containing our package and LAUNCHER
        const lines = stdout.split(/\r?\n/);
        let inMainLauncher = false;
        for (const line of lines) {
            if (/android\.intent\.action\.MAIN/.test(line)) {
                inMainLauncher = true;
            }
            if (inMainLauncher && /android\.intent\.category\.LAUNCHER/.test(line)) {
                // The component is usually a few lines above; scan backwards
                // Or look for the component in nearby lines
            }
            // Direct pattern: "activityName/className" in activity resolver
            if (inMainLauncher && line.includes(packageId) && line.includes('/')) {
                const match = line.match(new RegExp(`(${packageId.replace(/\./g, '\\.')}\/[\\w.$]+)`));
                if (match) {
                    out.appendLine(`[Android Runner] Resolved launcher from dumpsys: ${match[1]}`);
                    return match[1];
                }
            }
            // Reset if we hit a blank line (new section)
            if (line.trim() === '') { inMainLauncher = false; }
        }

        // Broader search: find the component from Activity Resolver Table
        const resolverRe = new RegExp(
            `(${packageId.replace(/\./g, '\\.')}\\/[\\w.$]+).*?MAIN.*?LAUNCHER`,
            's'
        );
        const resolverMatch = stdout.match(resolverRe);
        if (resolverMatch) {
            out.appendLine(`[Android Runner] Resolved launcher from dumpsys (broad): ${resolverMatch[1]}`);
            return resolverMatch[1];
        }
    } catch {
        // ignore
    }

    return undefined;
}

/**
 * Fallback launch when we cannot identify the launcher activity from the
 * manifest. Queries the device to resolve the correct component, then
 * launches via `am start -n`.
 */
export async function launchViaMonkey(serial: string, packageId: string, userId?: number): Promise<void> {
    const out = getOutputChannel();

    // Try to resolve the actual launcher component from the device
    const component = await resolveDeviceLauncherActivity(serial, packageId, userId);

    const adb = findAdb();
    if (component) {
        // Launch with the resolved component
        const args = ['-s', serial, 'shell', 'am', 'start'];
        if (typeof userId === 'number') {
            args.push('--user', String(userId));
        }
        args.push('-n', component);
        await runAdbStreaming(adb, args);
    } else {
        // Last resort: try am start with intent action (may fail on some setups)
        out.appendLine('[Android Runner] Could not resolve launcher activity; attempting intent-based launch…');
        const args = ['-s', serial, 'shell', 'am', 'start'];
        if (typeof userId === 'number') {
            args.push('--user', String(userId));
        }
        args.push('-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageId);
        await runAdbStreaming(adb, args);
    }
}

/**
 * Force-stop the app on the device before re-deploying (like Android Studio).
 */
export async function forceStop(serial: string, packageId: string, userId?: number): Promise<void> {
    const adb = findAdb();
    const args = ['-s', serial, 'shell', 'am', 'force-stop'];
    if (typeof userId === 'number') {
        args.push('--user', String(userId));
    }
    args.push(packageId);
    await runAdbStreaming(adb, args);
}

/**
 * Query the device to find the actual installed package name.
 * When the manifest package differs from the applicationId (common with
 * AGP 7+ namespace), the manifest-derived packageId won't match anything
 * on the device. This function searches `pm list packages` for the real name.
 *
 * Tries exact match first, then falls back to prefix/substring matching.
 */
export async function resolveInstalledPackage(
    serial: string,
    candidateIds: string[],
    userId?: number
): Promise<string | undefined> {
    const adb = findAdb();
    const out = getOutputChannel();
    const pmArgs = ['-s', serial, 'shell', 'pm', 'list', 'packages'];
    if (typeof userId === 'number') {
        pmArgs.push('--user', String(userId));
    }
    let stdout: string;
    try {
        stdout = await runAdbCapture(adb, pmArgs);
    } catch {
        return undefined;
    }

    const installed = stdout.split(/\r?\n/)
        .map(l => l.replace(/^package:/, '').trim())
        .filter(l => l.length > 0);

    // 1. Exact match for any candidate
    for (const candidate of candidateIds) {
        if (installed.includes(candidate)) {
            out.appendLine(`[Android Runner] Package verified on device: ${candidate}`);
            return candidate;
        }
    }

    // 2. Prefix match: find packages that start with a candidate
    for (const candidate of candidateIds) {
        const match = installed.find(p => p.startsWith(candidate));
        if (match) {
            out.appendLine(`[Android Runner] Package resolved via prefix match: ${match} (from ${candidate})`);
            return match;
        }
    }

    // 3. Reverse prefix: find candidate that is a prefix of installed packages
    for (const candidate of candidateIds) {
        // Try removing common suffixes like .bvt, .dev, .debug
        const base = candidate.replace(/\.(bvt|dev|debug|staging|beta|alpha)$/, '');
        if (base !== candidate) {
            const match = installed.find(p => p === base || p.startsWith(base + '.'));
            if (match) {
                out.appendLine(`[Android Runner] Package resolved via base match: ${match} (base=${base})`);
                return match;
            }
        }
    }

    return undefined;
}
