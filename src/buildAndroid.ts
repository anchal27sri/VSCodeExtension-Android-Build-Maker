import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

let outputChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Android Runner');
    }
    return outputChannel;
}

export interface BuildResult {
    apkPath: string;
}

/**
 * Runs the configured gradle task (default: assembleDebug) inside the given
 * workspace folder, streaming output to the Android Runner output channel.
 * Resolves with the path to the produced debug APK.
 */
export async function runBuild(
    folder: vscode.WorkspaceFolder,
    token: vscode.CancellationToken,
    progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<BuildResult> {
    const out = getOutputChannel();
    out.show(true);

    const root = folder.uri.fsPath;
    const isWindows = process.platform === 'win32';
    const wrapperName = isWindows ? 'gradlew.bat' : 'gradlew';
    const wrapperPath = path.join(root, wrapperName);

    if (!fs.existsSync(wrapperPath)) {
        const msg = `Gradle wrapper not found at ${wrapperPath}. Run "gradle wrapper" inside the project to generate it.`;
        out.appendLine(`[ERROR] ${msg}`);
        throw new Error(msg);
    }

    // Ensure gradlew is executable on POSIX
    if (!isWindows) {
        try {
            fs.chmodSync(wrapperPath, 0o755);
        } catch {
            // best effort
        }
    }

    const cfg = vscode.workspace.getConfiguration('androidRunner');
    const task = cfg.get<string>('gradleTask', 'assembleDebug');
    const extraArgs = cfg.get<string[]>('gradleArgs', []);
    const args = [task, ...extraArgs];

    out.appendLine('');
    out.appendLine('===============================================================');
    out.appendLine(`[Android Runner] Running: ${wrapperName} ${args.join(' ')}`);
    out.appendLine(`[Android Runner] CWD: ${root}`);
    out.appendLine('===============================================================');

    progress.report({ message: `gradle ${task}` });

    await new Promise<void>((resolve, reject) => {
        const child = cp.spawn(wrapperPath, args, {
            cwd: root,
            shell: false,
            env: process.env
        });

        const onCancel = token.onCancellationRequested(() => {
            out.appendLine('[Android Runner] Build cancelled by user.');
            try {
                child.kill('SIGTERM');
            } catch {
                // ignore
            }
        });

        const handleChunk = (data: Buffer) => {
            const text = data.toString();
            // strip trailing newline to avoid double-spacing
            for (const line of text.split(/\r?\n/)) {
                if (line.length > 0) {
                    out.appendLine(line);
                }
            }
        };

        child.stdout.on('data', handleChunk);
        child.stderr.on('data', handleChunk);

        child.on('error', (err) => {
            onCancel.dispose();
            reject(err);
        });

        child.on('close', (code) => {
            onCancel.dispose();
            if (token.isCancellationRequested) {
                reject(new Error('Build cancelled.'));
            } else if (code === 0) {
                out.appendLine(`[Android Runner] Build succeeded (exit 0).`);
                resolve();
            } else {
                reject(new Error(`Gradle build failed with exit code ${code}. See output for details.`));
            }
        });
    });

    progress.report({ message: 'locating APK…' });
    const apkPath = await locateApk(folder);
    out.appendLine(`[Android Runner] APK: ${apkPath}`);
    return { apkPath };
}

/**
 * Locate the freshly built debug APK. Prefers the conventional
 * app/build/outputs/apk/debug/*-debug.apk location; falls back to a
 * workspace-wide search and prompts the user if multiple match.
 */
async function locateApk(folder: vscode.WorkspaceFolder): Promise<string> {
    const pattern = new vscode.RelativePattern(folder, '**/build/outputs/apk/debug/*.apk');
    const exclude = '**/{node_modules,.gradle}/**';
    const found = await vscode.workspace.findFiles(pattern, exclude);

    if (found.length === 0) {
        throw new Error('No debug APK found under **/build/outputs/apk/debug/. Did the build actually produce an APK?');
    }

    // Prefer the conventional /app/build/outputs/apk/debug/*.apk path
    const preferred = found.find(u => /\/app\/build\/outputs\/apk\/debug\//.test(u.fsPath));
    if (preferred) {
        return preferred.fsPath;
    }

    if (found.length === 1) {
        return found[0].fsPath;
    }

    const pick = await vscode.window.showQuickPick(
        found.map(u => ({ label: path.basename(u.fsPath), description: u.fsPath, uri: u })),
        { placeHolder: 'Multiple debug APKs found. Select one to install.' }
    );
    if (!pick) {
        throw new Error('APK selection cancelled.');
    }
    return pick.uri.fsPath;
}
