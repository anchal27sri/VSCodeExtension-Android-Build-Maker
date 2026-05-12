import * as vscode from 'vscode';
import { isAndroidProject, resolveAndroidFolder } from './detectAndroidProject';
import { runBuild, getOutputChannel } from './buildAndroid';
import { pickDevice, pickUser, install, launch, launchViaMonkey } from './adb';
import { getLauncherInfo } from './manifestParser';

const CONTEXT_KEY = 'androidRunner.isAndroidProject';
const RUN_COMMAND = 'androidRunner.run';

let statusBarItem: vscode.StatusBarItem | undefined;
let isRunning = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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
                // 1. Build APK
                progress.report({ message: 'building APK…' });
                const { apkPath } = await runBuild(folder, token, progress);
                if (token.isCancellationRequested) { return; }

                // 2. Pick device (always prompt)
                setRunningState('Selecting device…');
                progress.report({ message: 'selecting device…' });
                const device = await pickDevice();
                if (!device) {
                    throw new Error('No device selected.');
                }

                // 3. Pick user profile (always prompt per user request)
                setRunningState('Selecting profile…');
                progress.report({ message: 'selecting profile…' });
                const user = await pickUser(device.serial);
                if (!user) {
                    throw new Error('No profile selected.');
                }

                // 4. Install
                setRunningState(`Installing on ${device.model ?? device.serial} (${user.name || `user ${user.id}`})…`);
                progress.report({ message: `installing on ${device.model ?? device.serial} as ${user.name || `user ${user.id}`}…` });
                await install(device.serial, apkPath, user.id);

                // 5. Resolve launcher activity & launch
                setRunningState('Launching…');
                progress.report({ message: 'launching app…' });
                try {
                    const info = await getLauncherInfo(folder);
                    if (info.activity) {
                        await launch(device.serial, info.packageId, info.activity, user.id);
                    } else {
                        await launchViaMonkey(device.serial, info.packageId, user.id);
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
