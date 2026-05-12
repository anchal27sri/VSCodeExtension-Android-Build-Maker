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
    /** Path to the produced APK. Empty when Gradle handled the install directly. */
    apkPath: string;
    /** True when the gradle task (e.g. installDebug) already installed the APK on the device. */
    installedViaGradle: boolean;
}

/** Base task names that install the APK as part of the build. */
const INSTALL_BASE_TASKS = ['install'];

/** Assemble task names that only build (no install). */
const ASSEMBLE_BASE_TASKS = ['assemble'];

/**
 * Extract flavor names from a productFlavors { ... } block in a gradle file's content.
 */
function extractFlavorsFromContent(content: string): string[] {
    const blockStart = content.indexOf('productFlavors');
    if (blockStart < 0) { return []; }
    // Walk braces to extract the block content
    let depth = 0;
    let start = -1;
    let end = -1;
    for (let i = blockStart; i < content.length; i++) {
        if (content[i] === '{') {
            if (depth === 0) { start = i + 1; }
            depth++;
        } else if (content[i] === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
        }
    }
    if (start < 0 || end < 0) { return []; }
    const block = content.substring(start, end);
    const flavors: string[] = [];
    // Groovy DSL:  flavorName { ... }
    const groovyRe = /^\s*(\w+)\s*\{/gm;
    let gm: RegExpExecArray | null;
    while ((gm = groovyRe.exec(block)) !== null) {
        const n = gm[1];
        // Skip Gradle DSL keywords / control-flow that appear inside productFlavors
        if (!['dimension', 'flavorDimensions', 'all', 'forEach', 'register', 'create',
              'named', 'matching', 'configureEach', 'withType', 'if', 'else'].includes(n)) {
            flavors.push(n);
        }
    }
    // Kotlin DSL:  create("flavorName") { ... }  or  register("flavorName")
    const ktsRe = /(?:create|register)\s*\(\s*"(\w+)"\s*\)/g;
    let km: RegExpExecArray | null;
    while ((km = ktsRe.exec(block)) !== null) {
        flavors.push(km[1]);
    }
    return flavors;
}

/**
 * Resolve `apply from:` references found in a gradle file.
 * Returns absolute paths of referenced gradle scripts.
 */
function resolveApplyFromRefs(content: string, fileDir: string, root: string): string[] {
    const refs: string[] = [];
    // Matches: apply from: "path"  /  apply from: 'path'  /  apply from: "$rootProject.projectDir/path"
    const re = /apply\s+from:\s*["']([^"']+)["']/g;
    // Also: apply from: "$rootProject.projectDir/path" (Groovy string interpolation)
    const reInterp = /apply\s+from:\s*"?\$(?:rootProject\.projectDir|rootDir)\/?([^"'\s]+)"?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        let ref = m[1];
        // Handle rootProject.projectDir references
        ref = ref.replace(/\$(?:rootProject\.projectDir|rootDir)\/?/, '');
        const abs = path.isAbsolute(ref) ? ref : path.resolve(fileDir, ref);
        if (fs.existsSync(abs)) { refs.push(abs); }
        // Also try relative to project root
        const fromRoot = path.resolve(root, ref);
        if (fromRoot !== abs && fs.existsSync(fromRoot)) { refs.push(fromRoot); }
    }
    while ((m = reInterp.exec(content)) !== null) {
        const fromRoot = path.resolve(root, m[1]);
        if (fs.existsSync(fromRoot)) { refs.push(fromRoot); }
    }
    return [...new Set(refs)];
}

/**
 * Detect product flavor names for the app module.
 *
 * Search order:
 *   1. The module's own build.gradle(.kts)
 *   2. Any file referenced via `apply from:` in the module build script
 *   3. Shared gradle scripts at <root>/gradle/*.gradle(*.kts)
 */
function detectProductFlavors(root: string, appModule: string): string[] {
    const modulePath = path.join(root, appModule);
    const buildFiles = ['build.gradle.kts', 'build.gradle'];

    for (const name of buildFiles) {
        const buildFile = path.join(modulePath, name);
        if (!fs.existsSync(buildFile)) { continue; }
        try {
            const content = fs.readFileSync(buildFile, 'utf8');

            // 1. Check the module build script directly
            const direct = extractFlavorsFromContent(content);
            if (direct.length > 0) { return direct; }

            // 2. Follow apply from: references
            const refs = resolveApplyFromRefs(content, modulePath, root);
            for (const ref of refs) {
                try {
                    const refContent = fs.readFileSync(ref, 'utf8');
                    const refFlavors = extractFlavorsFromContent(refContent);
                    if (refFlavors.length > 0) {
                        getOutputChannel().appendLine(
                            `[Android Runner] Found product flavors in applied script: ${ref}`
                        );
                        return refFlavors;
                    }
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }

    // 3. Fallback: scan shared gradle scripts at project root
    const sharedDir = path.join(root, 'gradle');
    if (fs.existsSync(sharedDir)) {
        try {
            const files = fs.readdirSync(sharedDir)
                .filter(f => f.endsWith('.gradle') || f.endsWith('.gradle.kts'));
            for (const f of files) {
                try {
                    const content = fs.readFileSync(path.join(sharedDir, f), 'utf8');
                    const flavors = extractFlavorsFromContent(content);
                    if (flavors.length > 0) {
                        getOutputChannel().appendLine(
                            `[Android Runner] Found product flavors in shared script: gradle/${f}`
                        );
                        return flavors;
                    }
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    }

    return [];
}

/** Capitalize first letter: "dev" → "Dev" */
function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Resolve the fully-qualified Gradle task name.
 *
 * Given a simple task like "installDebug":
 *  - Scopes it to the app module → ":app:installDebug"
 *  - Detects product flavors and inserts the flavor → ":app:installDevDebug"
 *  - When the user already specifies a colon-qualified path, uses it as-is.
 *
 * Returns the resolved task name and whether it is an install task.
 */
async function resolveGradleTask(
    root: string,
    cfg: vscode.WorkspaceConfiguration
): Promise<{ task: string; isInstallTask: boolean }> {
    const rawTask = cfg.get<string>('gradleTask', 'installDebug');
    const appModule = cfg.get<string>('appModule', 'app');

    // If the user already qualified the task (contains ":"), trust it.
    if (rawTask.includes(':')) {
        const isInstall = rawTask.toLowerCase().includes('install');
        return { task: rawTask, isInstallTask: isInstall };
    }

    // Determine if this is an install task and extract the build-type suffix.
    // e.g. "installDebug" → prefix="install", buildType="Debug"
    //      "assembleRelease" → prefix="assemble", buildType="Release"
    let prefix = '';
    let buildType = '';
    const lc = rawTask.toLowerCase();
    for (const base of [...INSTALL_BASE_TASKS, ...ASSEMBLE_BASE_TASKS]) {
        if (lc.startsWith(base)) {
            prefix = rawTask.substring(0, base.length);   // preserve original casing
            buildType = rawTask.substring(base.length);     // e.g. "Debug"
            break;
        }
    }
    const isInstall = INSTALL_BASE_TASKS.some(b => lc.startsWith(b));

    // Detect product flavors in the app module
    const flavors = detectProductFlavors(root, appModule);

    let task: string;
    if (flavors.length > 0 && prefix && buildType) {
        // Project has flavors — inject the flavor name between prefix and buildType.
        const configuredFlavor = cfg.get<string>('buildFlavor', '').trim();
        let chosenFlavor: string;

        if (configuredFlavor) {
            // User has a configured flavor — use it directly
            chosenFlavor = configuredFlavor;
            getOutputChannel().appendLine(`[Android Runner] Using configured flavor: ${chosenFlavor}`);
        } else if (flavors.length === 1) {
            // Only one flavor detected — auto-select
            chosenFlavor = flavors[0];
        } else {
            // Multiple flavors — prompt and save the choice
            const pick = await vscode.window.showQuickPick(
                flavors.map(f => ({ label: f, description: `${prefix}${capitalize(f)}${buildType}` })),
                { placeHolder: 'Multiple product flavors detected. Select one (saved to settings):' }
            );
            if (!pick) {
                throw new Error('Build variant selection cancelled.');
            }
            chosenFlavor = pick.label;
            // Save to workspace settings so the user isn't prompted again
            await vscode.workspace.getConfiguration('androidRunner')
                .update('buildFlavor', chosenFlavor, vscode.ConfigurationTarget.Workspace);
            getOutputChannel().appendLine(`[Android Runner] Saved flavor "${chosenFlavor}" to workspace settings.`);
        }

        task = `:${appModule}:${prefix}${capitalize(chosenFlavor)}${buildType}`;
        getOutputChannel().appendLine(`[Android Runner] Detected flavor "${chosenFlavor}" → task ${task}`);
    } else {
        // No flavors — just scope to the module.
        task = `:${appModule}:${rawTask}`;
    }

    return { task, isInstallTask: isInstall };
}

/**
 * Runs the configured gradle task inside the given workspace folder,
 * streaming output to the Android Runner output channel.
 *
 * When the task is an install* task and a deviceSerial is provided, the
 * device serial is injected via -Pandroid.injected.deviceSerialNumber so
 * Gradle pushes split-APKs directly — matching Android Studio behaviour.
 */
export async function runBuild(
    folder: vscode.WorkspaceFolder,
    token: vscode.CancellationToken,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    deviceSerial?: string
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
    const { task, isInstallTask } = await resolveGradleTask(root, cfg);
    const extraArgs = cfg.get<string[]>('gradleArgs', []);

    // Gradle caching & performance flags (mirrors Android Studio behaviour)
    const perfFlags: string[] = ['--daemon'];
    if (cfg.get<boolean>('enableBuildCache', true)) {
        perfFlags.push('--build-cache');
    }
    if (cfg.get<boolean>('enableConfigurationCache', false)) {
        perfFlags.push('--configuration-cache');
    }
    if (cfg.get<boolean>('enableParallelBuild', true)) {
        perfFlags.push('--parallel');
    }
    if (cfg.get<boolean>('offlineMode', false)) {
        perfFlags.push('--offline');
    }

    // Inject device serial so install tasks target the correct device
    const injectArgs: string[] = [];
    if (isInstallTask && deviceSerial) {
        injectArgs.push(`-Pandroid.injected.deviceSerialNumber=${deviceSerial}`);
    }

    const args = [task, ...perfFlags, ...injectArgs, ...extraArgs];

    out.appendLine('');
    out.appendLine('===============================================================');
    out.appendLine(`[Android Runner] Running: ${wrapperName} ${args.join(' ')}`);
    out.appendLine(`[Android Runner] CWD: ${root}`);
    out.appendLine('===============================================================');

    progress.report({ message: `gradle ${task}` });

    // Boost Gradle JVM memory if the user hasn't set GRADLE_OPTS
    const gradleJvmArgs = cfg.get<string>('gradleJvmArgs', '-Xmx2048m');
    const spawnEnv = { ...process.env };
    if (gradleJvmArgs && !spawnEnv.GRADLE_OPTS) {
        spawnEnv.GRADLE_OPTS = gradleJvmArgs;
        out.appendLine(`[Android Runner] GRADLE_OPTS=${gradleJvmArgs}`);
    }

    await new Promise<void>((resolve, reject) => {
        const child = cp.spawn(wrapperPath, args, {
            cwd: root,
            shell: false,
            env: spawnEnv
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

    // When using an install task, Gradle already pushed the APK to the device
    if (isInstallTask && deviceSerial) {
        out.appendLine('[Android Runner] APK installed via Gradle (split APKs / incremental).');
        return { apkPath: '', installedViaGradle: true };
    }

    progress.report({ message: 'locating APK…' });
    const apkPath = await locateApk(folder);
    out.appendLine(`[Android Runner] APK: ${apkPath}`);
    return { apkPath, installedViaGradle: false };
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
