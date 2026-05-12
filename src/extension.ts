import * as vscode from 'vscode';
import { isAndroidProject, resolveAndroidFolder } from './detectAndroidProject';
import { runBuild, getOutputChannel } from './buildAndroid';
import { pickDevice, pickUser, listDevices, listUsers, install, launch, launchViaMonkey, forceStop, resolveInstalledPackage, AdbDevice, AdbUser } from './adb';
import { getLauncherInfo, resolveApplicationId } from './manifestParser';

const CONTEXT_KEY = 'androidRunner.isAndroidProject';
const RUN_COMMAND = 'androidRunner.run';
const LAST_DEVICE_KEY = 'androidRunner.lastDeviceSerial';
const LAST_USER_KEY = 'androidRunner.lastUserId';

let statusBarItem: vscode.StatusBarItem | undefined;
let isRunning = false;
let workspaceState: vscode.Memento;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    workspaceState = context.workspaceState;

    // Status bar item: leftmost (high priority), green background.
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000);
    statusBarItem.command = RUN_COMMAND;
    setIdleState();
    context.subscriptions.push(statusBarItem);

    // Register the run command.
    context.subscriptions.push(
        vscode.commands.registerCommand(RUN_COMMAND, runHandler)
    );

    // Detection runs on activation and whenever the workspace changes.
    await refreshDetection();

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => { void refreshDetection(); })
    );

    // File system watcher for project markers
    const watcher = vscode.workspace.createFileSystemWatcher(
        '**/{settings.gradle,settings.gradle.kts,build.gradle,build.gradle.kts,gradlew,AndroidManifest.xml}'
    );
    const onChange = () => { void refreshDetection(); };
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    context.subscriptions.push(watcher);
}

export function deactivate(): void {
    statusBarItem?.dispose();
    statusBarItem = undefined;
}

async function refreshDetection(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let anyAndroid = false;
    for (const f of folders) {
        if (await isAndroidProject(f)) { anyAndroid = true; break; }
    }
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, anyAndroid);
    if (!statusBarItem) { return; }
    if (anyAndroid) {
        statusBarItem.show();
    } else {
        statusBarItem.hide();
    }
}

function setIdleState(): void {
    if (!statusBarItem) { return; }
    statusBarItem.text = '$(play) Run Android';
    statusBarItem.tooltip = 'Android Runner: build (gradle), install on a connected device, and launch';
    statusBarItem.backgroundColor = new vscode.ThemeColor('androidRunner.runButtonBackground');
    statusBarItem.color = new vscode.ThemeColor('androidRunner.runButtonForeground');
}

function setRunningState(message: string): void {
    if (!statusBarItem) { return; }
    statusBarItem.text = `$(sync~spin) ${message}`;
    statusBarItem.tooltip = 'Android Runner: in progress (click to view logs)';
}

async function runHandler(): Promise<void> {
    if (isRunning) {
        vscode.window.showInformationMessage('Android Runner is already in progress.');
        getOutputChannel().show(true);
        return;
    }

    const folder = await resolveAndroidFolder();
    if (!folder) {
        vscode.window.showErrorMessage('No Android project detected in the current workspace.');
        return;
    }

    isRunning = true;
    setRunningState('Building…');

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Android Runner',
                cancellable: true
            },
            async (progress, token) => {
                const cfg = vscode.workspace.getConfiguration('androidRunner');
                const remember = cfg.get<boolean>('rememberDevice', true);

                // 1. Resolve device FIRST so we can inject the serial into Gradle
                setRunningState('Selecting device…');
                progress.report({ message: 'selecting device…' });
                let device: AdbDevice | undefined;
                if (remember) {
                    const lastSerial = workspaceState.get<string>(LAST_DEVICE_KEY);
                    if (lastSerial) {
                        try {
                            const online = (await listDevices()).filter(d => d.state === 'device');
                            device = online.find(d => d.serial === lastSerial);
                            if (device) {
                                getOutputChannel().appendLine(
                                    `[Android Runner] Reusing remembered device: ${device.model ?? device.serial}`
                                );
                            }
                        } catch {
                            // fall through to picker
                        }
                    }
                }
                if (!device) {
                    device = await pickDevice();
                }
                if (!device) {
                    throw new Error('No device selected.');
                }
                if (remember) {
                    await workspaceState.update(LAST_DEVICE_KEY, device.serial);
                }

                // 2. Resolve user profile — reuse remembered user if still present
                setRunningState('Selecting profile…');
                progress.report({ message: 'selecting profile…' });
                let user: AdbUser | undefined;
                if (remember) {
                    const lastUserId = workspaceState.get<number>(LAST_USER_KEY);
                    if (typeof lastUserId === 'number') {
                        try {
                            const users = await listUsers(device.serial);
                            user = users.find(u => u.id === lastUserId);
                            if (user) {
                                getOutputChannel().appendLine(
                                    `[Android Runner] Reusing remembered profile: ${user.name || `user ${user.id}`}`
                                );
                            }
                        } catch {
                            // fall through to picker
                        }
                    }
                }
                if (!user) {
                    user = await pickUser(device.serial);
                }
                if (!user) {
                    throw new Error('No profile selected.');
                }
                if (remember) {
                    await workspaceState.update(LAST_USER_KEY, user.id);
                }

                // 3. Build (pass device serial so installDebug can target it)
                setRunningState('Building…');
                progress.report({ message: 'building…' });
                const { apkPath, installedViaGradle } = await runBuild(folder, token, progress, device.serial);
                if (token.isCancellationRequested) { return; }

                // 4. Install — skip when Gradle already handled it (installDebug)
                if (!installedViaGradle) {
                    setRunningState(`Installing on ${device.model ?? device.serial} (${user.name || `user ${user.id}`})…`);
                    progress.report({ message: `installing on ${device.model ?? device.serial} as ${user.name || `user ${user.id}`}…` });
                    await install(device.serial, apkPath, user.id);
                }

                // 5. Resolve launcher activity, force-stop, & launch
                setRunningState('Launching…');
                progress.report({ message: 'launching app…' });
                try {
                    const info = await getLauncherInfo(folder);
                    const appModule = cfg.get<string>('appModule', 'app');

                    // Resolve the real applicationId (may differ from manifest package/namespace)
                    const gradleAppId = resolveApplicationId(folder, appModule);
                    const candidateIds = [
                        ...(gradleAppId ? [gradleAppId] : []),
                        info.packageId
                    ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

                    // Verify which package is actually installed on the device
                    const resolvedPkg = await resolveInstalledPackage(device.serial, candidateIds, user.id)
                        ?? gradleAppId ?? info.packageId;

                    getOutputChannel().appendLine(`[Android Runner] Using applicationId: ${resolvedPkg}`);

                    // Force-stop before launch so the process restarts cleanly
                    if (cfg.get<boolean>('forceStopBeforeLaunch', true)) {
                        getOutputChannel().appendLine('[Android Runner] Force-stopping app before launch…');
                        await forceStop(device.serial, resolvedPkg, user.id);
                    }

                    if (info.activity) {
                        await launch(device.serial, resolvedPkg, info.activity, user.id);
                    } else {
                        await launchViaMonkey(device.serial, resolvedPkg, user.id);
                    }
                } catch (err: any) {
                    getOutputChannel().appendLine(`[Android Runner] Could not auto-launch app: ${err.message}`);
                    vscode.window.showWarningMessage(
                        `Installed, but could not launch the app automatically: ${err.message}`
                    );
                }

                vscode.window.showInformationMessage(
                    `Android Runner: installed and launched on ${device.model ?? device.serial} (${user.name || `user ${user.id}`}).`
                );
            }
        );
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        getOutputChannel().appendLine(`[Android Runner] FAILED: ${msg}`);
        const choice = await vscode.window.showErrorMessage(`Android Runner failed: ${msg}`, 'Open Logs');
        if (choice === 'Open Logs') {
            getOutputChannel().show(true);
        }
    } finally {
        isRunning = false;
        setIdleState();
    }
}
